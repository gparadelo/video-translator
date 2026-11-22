// The produce half of a job, per language, as short steps the job page calls one after another through the
// produce routes (app/api/jobs/<id>/produce/<lang>/...): scripts/vt.py's produce() loop up to the recorded voice,
//
//   translate  -> work/<lang>/script.json             (vt.translate_lang; returns at once when there is one)
//   tts (each beat) -> work/<lang>/tts/<clip>, copied into out/<lang>/g<n>/tts/   (vt.tts_beat, cached)
//   fit        -> the timing plan from the clips: nothing flagged, or the last round -> out/<lang>/g<n>/inputs.json
//                 and the language is voiced; otherwise ->
//   translate (rewrite) -> Claude rewrites the flagged beats (vt.refit_lang), round + 1 -> tts -> fit ...
//
// Each step does one paid call at most and saves what it made before it answers, so a step can always be asked
// again (a dropped connection, a closed tab): it picks up from what's saved. Every step checks the run
// (generation) and the round it was asked for, so an older tab can't write into a newer run.
// Server only. Storage, Claude and ElevenLabs come in as arguments (fakes in tests).

import { clipDuration } from "../pipeline/build";
import { FIT } from "../pipeline/config";
import { INPUTS_FORMAT, metaFile, parseClipMeta, type ClipMeta, type PlanInputs } from "../pipeline/inputs";
import { mp3Samples } from "../pipeline/mp3";
import { buildPlan, type Clip as PlanClip, type Plan } from "../pipeline/plan";
import { createHash } from "node:crypto";
import { parseAnalysis, inputsAnalysis, type Analysis } from "./analysis";
import { CLAUDE } from "./config";
import { ProduceError } from "./errors";
import { outputKey, workKey } from "./keys";
import { checkScript, claudeScript, fixPrompt, langScript, refitPrompt, translatePrompt, type ClaudeClient, type Message, type ScriptBeat } from "./translate";
import { requestTts, ttsBody, ttsKey, voicedTexts, type TtsBody } from "./tts";

/** Object storage (R2 in the app). Keys are whole object keys. */
export type Store = {
  /** the object's bytes, or null when it isn't there; throws when it is bigger than maxBytes */
  get(key: string, maxBytes: number): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  /** false when `from` isn't there */
  copy(from: string, to: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
};

/** One run of one language, as the route found it in the database (the person's own row). */
export type Run = {
  store: Store;
  userId: string;
  jobId: string;
  lang: string;
  generation: number;
  /** the language's pinned voice (jobs.voices) */
  voice: string;
  /** jobs.analysis_key */
  analysisKey: string;
  /** what an API call cost (usage_events); a failure here never fails the step */
  logUsage?: (service: "claude" | "elevenlabs_tts", amounts: Record<string, string | number>) => Promise<void>;
};

export const SCRIPT_FORMAT = 1;

/** work/<lang>/script.json: vt.write_lang_script's {lang, beats}, plus which analysis, run and round it is for. */
export type LangScript = {
  format: number;
  lang: string;
  /** analysisId of the analysis it translates: a new analysis (edited transcript) means a new translation */
  base: string;
  /** the run it was last used in, and how many times Claude rewrote it in that run */
  generation: number;
  round: number;
  beats: ScriptBeat[];
};

/** work/<lang>/ask.json: a translation Claude got wrong, with what to ask next (vt.ask_until_valid's messages). */
type Ask = { kind: "translate" | "rewrite"; generation: number; round: number; attempt: number; messages: Message[] };

/** How many times Claude is asked for a translation without problems before the language fails (vt.ask_until_valid). */
export const TRIES = 3;

const td = new TextDecoder();
const work = (r: Run, file: string) => workKey(r.userId, r.jobId, r.lang, file);
const out = (r: Run, file: string) => outputKey(r.userId, r.jobId, r.lang, r.generation, file);

async function readJson<T>(r: Run, key: string, maxBytes: number, what: string): Promise<T | null> {
  const bytes = await r.store.get(key, maxBytes);
  if (!bytes) return null;
  try {
    return JSON.parse(td.decode(bytes)) as T;
  } catch {
    throw new ProduceError(`the saved ${what} is unreadable`, { status: 500 });
  }
}

const putJson = (r: Run, key: string, value: unknown, indent?: number) =>
  r.store.put(key, JSON.stringify(value, null, indent), "application/json");

/** The analysis's identity for its translations: the beats with their markers, in the original's language. */
export const analysisId = (A: Analysis) =>
  createHash("sha1").update(JSON.stringify([A.base_lang, A.beats.map((b) => [b.id, b.marked])])).digest("hex").slice(0, 16);

export async function loadAnalysis(r: Run): Promise<Analysis> {
  const json = await readJson(r, r.analysisKey, 5_000_000, "analysis of the video");
  if (json === null) {
    throw new ProduceError("the analysis of the video is missing (files are kept for 30 days): approve the transcript again");
  }
  return parseAnalysis(json);
}

async function loadScript(r: Run, A: Analysis): Promise<LangScript | null> {
  const s = await readJson<LangScript>(r, work(r, "script.json"), 2_000_000, "translation");
  const ok = s && s.format === SCRIPT_FORMAT && s.lang === r.lang && s.base === analysisId(A) && Array.isArray(s.beats) &&
    s.beats.length === A.beats.length && Number.isInteger(s.round) && Number.isInteger(s.generation);
  return ok ? s : null;
}

/** The translation the run is at, which must be the one the request is about (round), or the run moved on. */
async function scriptAt(r: Run, A: Analysis, round: number): Promise<LangScript> {
  const s = await loadScript(r, A);
  if (!s || s.generation !== r.generation || s.round !== round) {
    throw new ProduceError("the translation changed meanwhile - continuing from it", { status: 409, code: "stale" });
  }
  return s;
}

export type BeatClip = { key: string; file: string; body: TtsBody };

/** Every beat's TTS request and clip name, as vt.cmd_tts makes them. */
export function beatClips(r: Run, beats: ScriptBeat[]): BeatClip[] {
  const texts = voicedTexts(beats);
  return beats.map((b, i) => {
    const body = ttsBody(texts, i, r.lang, b.speed);
    const key = ttsKey(r.voice, body);
    return { key, file: `${key}.mp3`, body };
  });
}

/** A clip's length in seconds as vt.py sees it (ffprobe), from the MP3's header: no decoding. */
export function mp3Duration(mp3: Uint8Array): number {
  const n = mp3Samples(mp3);
  if (n === null) throw new ProduceError("a recorded beat isn't an MP3 file: try again", { retry: true });
  return clipDuration(n);
}

/** The clips of this run's tts/ folder, read back: each one's timing and length. */
async function runClips(r: Run, clips: BeatClip[]): Promise<PlanClip[]> {
  return Promise.all(clips.map(async (c) => {
    const [meta, mp3] = await Promise.all([
      readJson<ClipMeta>(r, out(r, `tts/${metaFile(c.file)}`), 2_000_000, "voice timing"),
      r.store.get(out(r, `tts/${c.file}`), 10_000_000),
    ]);
    if (!meta || !mp3) throw new ProduceError("a beat's voice isn't recorded yet - recording it", { status: 409, code: "stale" });
    return { meta: parseClipMeta(meta, c.file), duration: mp3Duration(mp3) };
  }));
}

/** vt.plan_inputs: what the browser builds the plan and the voice track from (inputs.json, format 1). */
export function planInputs(r: Run, A: Analysis, beats: ScriptBeat[], clips: BeatClip[]): PlanInputs {
  return {
    format: INPUTS_FORMAT,
    lang: r.lang,
    voice_id: r.voice,
    analysis: inputsAnalysis(A),
    fit: { ...FIT },
    script: beats.map((b) => ({ id: b.id, text: b.text, ...(b.speed !== undefined && { speed: b.speed }) })),
    clips: beats.map((b, i) => ({ beat: b.id, file: clips[i].file, speed: clips[i].body.voice_settings.speed })),
  };
}

/** vt.build_plan on this run's clips: the plan the rewrite loop decides on. */
async function planOf(r: Run, A: Analysis, s: LangScript): Promise<{ plan: Plan; inputs: PlanInputs }> {
  const clips = beatClips(r, s.beats);
  const inputs = planInputs(r, A, s.beats, clips);
  return { plan: buildPlan(inputs, await runClips(r, clips)), inputs };
}

// ------------------------------------------------------------------ translate

export type TranslateResult =
  | { done: true; round: number; beats: number }
  | { done: false; problems: string[]; attempt: number };

/**
 * kind "translate": the language's translation (vt.translate_lang), or the saved one. kind "rewrite": Claude
 * rewrites the beats the plan of `round` flagged (vt.refit_lang) -> round + 1. One Claude call at most: when
 * the answer has problems (vt.check_script), they are saved with the conversation and the answer is
 * {done: false}; ask again to give Claude the next try.
 */
export async function translateStep(r: Run, claude: ClaudeClient, req: { kind: "translate" | "rewrite"; round?: number }): Promise<TranslateResult> {
  const A = await loadAnalysis(r);
  const base = analysisId(A);
  const cur = await loadScript(r, A);
  let round: number;
  let first: Message[];
  if (req.kind === "translate") {
    if (cur) {
      if (cur.generation !== r.generation) { // a new run starts its rounds from the saved translation
        Object.assign(cur, { generation: r.generation, round: 0 });
        await putJson(r, work(r, "script.json"), cur, 1);
      }
      return { done: true, round: cur.round, beats: cur.beats.length };
    }
    round = 0;
    first = [{ role: "user", content: translatePrompt(A, r.lang) }];
  } else {
    round = req.round ?? -1;
    if (!cur || cur.generation !== r.generation) {
      throw new ProduceError("the translation changed meanwhile - continuing from it", { status: 409, code: "stale" });
    }
    if (cur.round !== round || round >= CLAUDE.fix_rounds) return { done: true, round: cur.round, beats: cur.beats.length };
    const { plan } = await planOf(r, A, cur);
    if (!plan.flags.length) return { done: true, round: cur.round, beats: cur.beats.length };
    first = [{ role: "user", content: refitPrompt(A, r.lang, cur.beats, plan) }];
  }

  const askKey = work(r, "ask.json");
  const ask = await readJson<Ask>(r, askKey, 5_000_000, "conversation");
  const same = ask && ask.kind === req.kind && ask.generation === r.generation && ask.round === round &&
    Array.isArray(ask.messages) && Number.isInteger(ask.attempt) && ask.attempt < TRIES;
  const messages = same ? ask.messages : first;
  const attempt = same ? ask.attempt : 0;

  const { beats, reply, usage } = await claudeScript(claude, messages);
  await r.logUsage?.("claude", usage).catch(() => {});
  const errs = checkScript(A.beats, beats);
  if (!errs.length) {
    const s: LangScript = { format: SCRIPT_FORMAT, lang: r.lang, base, generation: r.generation,
                            round: req.kind === "translate" ? 0 : round + 1, beats: langScript(beats) };
    await putJson(r, work(r, "script.json"), s, 1);
    if (ask) await r.store.remove(askKey);
    return { done: true, round: s.round, beats: s.beats.length };
  }
  if (attempt + 1 >= TRIES) {
    await r.store.remove(askKey);
    throw new ProduceError(`Claude's ${r.lang} translation still has problems after ${TRIES} tries: ${errs.join("; ")}`);
  }
  const next: Ask = { kind: req.kind, generation: r.generation, round, attempt: attempt + 1,
                      messages: [...messages, reply, { role: "user", content: fixPrompt(errs) }] };
  await putJson(r, askKey, next);
  return { done: false, problems: errs, attempt: attempt + 1 };
}

// ------------------------------------------------------------------ tts

export type TtsResult = { beat: number; file: string; cached: boolean; duration: number };

/**
 * Beat `beat` (index) of the translation at `round`, voiced (vt.tts_beat): already in this run's folder, or in
 * the language's cache (an earlier run or round voiced the same request), or a new ElevenLabs call. Ends with
 * tts/<clip>.mp3 and tts/<clip>.json in the run's folder.
 */
export async function ttsStep(r: Run, eleven: { apiKey: string; fetchFn?: typeof fetch; api?: string },
                              req: { round: number; beat: number }): Promise<TtsResult> {
  const A = await loadAnalysis(r);
  const s = await scriptAt(r, A, req.round);
  if (!Number.isInteger(req.beat) || req.beat < 0 || req.beat >= s.beats.length) throw new ProduceError("no such beat", { status: 400 });
  const clip = beatClips(r, s.beats)[req.beat];
  const runMp3 = out(r, `tts/${clip.file}`), runJson = out(r, `tts/${metaFile(clip.file)}`);
  const cacheMp3 = work(r, `tts/${clip.file}`), cacheJson = work(r, `tts/${metaFile(clip.file)}`);

  const inRun = await r.store.get(runMp3, 10_000_000);
  if (inRun && (await r.store.exists(runJson))) return { beat: req.beat, file: clip.file, cached: true, duration: mp3Duration(inRun) };

  const cached = await r.store.get(cacheMp3, 10_000_000);
  if (cached && (await r.store.exists(cacheJson))) {
    await r.store.put(runMp3, cached, "audio/mpeg");
    if (!(await r.store.copy(cacheJson, runJson))) throw new ProduceError("the saved voice timing went missing - trying again", { retry: true });
    return { beat: req.beat, file: clip.file, cached: true, duration: mp3Duration(cached) };
  }

  const { mp3, meta } = await requestTts(eleven.apiKey, r.voice, clip.body, { fetchFn: eleven.fetchFn, api: eleven.api });
  const duration = mp3Duration(mp3); // refuse a clip the plan can't use before paying for storing it
  await r.logUsage?.("elevenlabs_tts", { characters: Array.from(clip.body.text).length }).catch(() => {});
  const json = JSON.stringify(meta);
  // the cache first: if the run's copy fails, the next try takes it from there instead of paying again
  await r.store.put(cacheMp3, mp3, "audio/mpeg");
  await r.store.put(cacheJson, json, "application/json");
  await r.store.put(runMp3, mp3, "audio/mpeg");
  await r.store.put(runJson, json, "application/json");
  return { beat: req.beat, file: clip.file, cached: false, duration };
}

// ------------------------------------------------------------------ fit

export type FitResult = { voiced: boolean; round: number; flags: string[] };

/**
 * The plan of the translation at `round` from its clips (vt.cmd_plan): with nothing flagged, or after the last
 * round of rewrites, the run's inputs.json is written (last, after every clip it names) and `markVoiced` marks the
 * language voiced. Otherwise {voiced: false}: the beats to rewrite are in the flags.
 */
export async function fitStep(r: Run, req: { round: number }, markVoiced: () => Promise<void>): Promise<FitResult> {
  const A = await loadAnalysis(r);
  const s = await scriptAt(r, A, req.round);
  const { plan, inputs } = await planOf(r, A, s);
  const flags = plan.flags.map((f) => f.msg);
  if (flags.length && s.round < CLAUDE.fix_rounds) return { voiced: false, round: s.round, flags };
  await putJson(r, out(r, "inputs.json"), inputs, 1);
  await markVoiced();
  return { voiced: true, round: s.round, flags };
}
