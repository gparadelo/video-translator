// The prepare half of a job, as short steps the job page calls one after another through the prepare routes
// (app/api/jobs/<id>/prepare/...): scripts/vt.py's prepare() (cmd_analyze, transcribe, fix_names, cmd_analyze again)
// and the worker's align, without the worker:
//
//   media       the browser measures the video (lib/prepare/local.ts) and uploads the voiceover's audio and
//               prep/media.json; this step hands out the upload links and checks what arrived
//   transcribe  ElevenLabs speech-to-text of prep/audio.*           -> prep/transcript.json   (vt.transcribe)
//   names       Claude checks the spelling of names in it            -> prep/names.json        (vt.fix_names)
//   align       ElevenLabs forced alignment of the transcript       -> prep/alignment.json    (vt.forced_align)
//               and the analysis                                    -> analysis.json          (vt.cmd_analyze)
//               then the project is ready for review (save_prepared)
//
// and after the person approved an edited transcript (job "aligning"): align again (worker.Job.align) -> producing,
// or back to the review when the edits broke the timing (save_aligned).
//
// Each step does one paid call at most and saves what it made before it answers, so a step can always be asked
// again (a dropped connection, a closed tab): it picks up from what's saved, and nothing is paid twice. One
// deliberate difference from vt.prepare: when the name check changes the transcript, vt.py had already timed the
// unfixed one and times it again; here the names are checked first, so the voiceover is aligned once. The analysis
// is the same (test/prepare-parity.test.ts).
// Server only. Storage, ElevenLabs and Claude come in as arguments (fakes in tests).

import { ProduceError } from "../produce/errors";
import { parseAnalysis, type Analysis } from "../produce/analysis";
import type { Store } from "../produce/steps";
import type { ClaudeClient, ClaudeUsage } from "../produce/translate";
import { analyzeVoiceover, cutsAsSaved, lang2, scriptFromWords, splitBeats, type Alignment } from "./analyze";
import { ANALYZE } from "./config";
import { forcedAlign, transcribe, type Transcript } from "./eleven";
import { AUDIO_FILES, MAX_AUDIO_BYTES, MAX_MEDIA_BYTES, MEDIA_FORMAT, parseMedia, type AudioFile, type Media } from "./media";
import { checkNames } from "./names";

export type PrepService = "claude" | "elevenlabs_stt" | "elevenlabs_alignment";

/** One project being prepared (or aligned), as the route found it in the database (the person's own row). */
export type PrepJob = {
  store: Store;
  userId: string;
  jobId: string;
  status: "preparing" | "aligning";
  /** jobs.base_lang, jobs.script, jobs.reference, jobs.warnings, jobs.analysis_key */
  baseLang: string | null;
  script: string | null;
  reference: string | null;
  warnings: string[];
  analysisKey: string | null;
  logUsage?: (service: PrepService, amounts: Record<string, string | number>) => Promise<void>;
};

/** Signed links for the browser (R2 in the app). */
export type Links = {
  put(key: string, bytes: number, contentType: string): Promise<string>;
  get(key: string): Promise<string>;
  size(key: string): Promise<number | null>;
};

const td = new TextDecoder();
const base = (j: PrepJob) => `u/${j.userId}/${j.jobId}`;
/** u/<user>/<job>/prep/<file>: what the prepare steps keep (see "Files in storage" in docs/web-setup.md). */
export const prepKey = (j: Pick<PrepJob, "userId" | "jobId">, file: string) => `u/${j.userId}/${j.jobId}/prep/${file}`;
export const analysisKey = (j: Pick<PrepJob, "userId" | "jobId">) => `u/${j.userId}/${j.jobId}/analysis.json`;
const sourceKey = (j: PrepJob) => `${base(j)}/source`;

async function readJson<T>(j: PrepJob, key: string, maxBytes: number): Promise<T | null> {
  const bytes = await j.store.get(key, maxBytes);
  if (!bytes) return null;
  try {
    return JSON.parse(td.decode(bytes)) as T;
  } catch {
    return null; // unreadable: made again
  }
}
const putJson = (j: PrepJob, key: string, value: unknown) => j.store.put(key, JSON.stringify(value, null, 1), "application/json");

const GONE = "the video is no longer in storage (files are kept for 30 days). Upload it again as a new project";

/** prep/media.json, checked, with its voiceover in storage; null when either isn't there (yet). */
export async function loadMedia(j: PrepJob, store?: Links): Promise<Media | null> {
  const json = await readJson<unknown>(j, prepKey(j, "media.json"), MAX_MEDIA_BYTES);
  if (json === null) return null;
  let m: Media;
  try {
    m = parseMedia(json);
  } catch {
    return null;
  }
  const size = store ? await store.size(prepKey(j, m.audio)) : (await j.store.exists(prepKey(j, m.audio))) ? m.audio_bytes : null;
  return size === m.audio_bytes ? m : null;
}

async function needMedia(j: PrepJob): Promise<Media> {
  const m = await loadMedia(j);
  if (!m) throw new ProduceError("the video hasn't been measured yet - measuring it", { status: 409, code: "stale" });
  return m;
}

/** The analysis.json already in storage (an older worker's, or the last one made here), or null. */
async function savedAnalysis(j: PrepJob): Promise<Analysis | null> {
  const json = await readJson<unknown>(j, j.analysisKey ?? analysisKey(j), 5_000_000);
  if (json === null) return null;
  try {
    return parseAnalysis(json);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ media

export type MediaResult =
  | { ready: true; dur: number; cuts: number }
  /** measure: the browser has to read the video (no analysis.json to take the measures from); source: a link to it */
  | { ready: false; measure: boolean; source: string }
  | { ready: false; uploads: { audio: string; media: string | null } };

export type MediaRequest =
  | { phase: "start" }
  | { phase: "upload"; audio: AudioFile; audio_bytes: number; media_bytes?: number }
  | { phase: "done"; audio: AudioFile; audio_bytes: number };

export async function mediaStep(j: PrepJob, links: Links, req: MediaRequest): Promise<MediaResult> {
  const have = await loadMedia(j, links);
  if (have) return { ready: true, dur: have.dur, cuts: have.cuts.length };
  // an older worker's analysis.json has the measures (vt.py's own); then only the voiceover is needed
  const derived = await savedAnalysis(j);
  if (req.phase === "start") {
    if ((await links.size(sourceKey(j))) === null) throw new ProduceError(GONE, { status: 410 });
    return { ready: false, measure: !derived, source: await links.get(sourceKey(j)) };
  }
  if (!(req.audio in AUDIO_FILES)) throw new ProduceError("unknown voiceover file", { status: 400 });
  if (!Number.isInteger(req.audio_bytes) || req.audio_bytes < 1 || req.audio_bytes > MAX_AUDIO_BYTES) {
    throw new ProduceError("the voiceover is too big", { status: 413 });
  }
  if (req.phase === "upload") {
    const mediaBytes = req.media_bytes;
    if (!derived && !(Number.isInteger(mediaBytes) && mediaBytes! > 0 && mediaBytes! <= MAX_MEDIA_BYTES)) {
      throw new ProduceError("the measurements of the video are missing", { status: 400 });
    }
    return {
      ready: false,
      uploads: {
        audio: await links.put(prepKey(j, req.audio), req.audio_bytes, AUDIO_FILES[req.audio]),
        media: derived ? null : await links.put(prepKey(j, "media.json"), mediaBytes!, "application/json"),
      },
    };
  }
  // done: check what arrived
  if ((await links.size(prepKey(j, req.audio))) !== req.audio_bytes) {
    throw new ProduceError("the voiceover didn't arrive whole - uploading it again", { status: 409, code: "stale" });
  }
  let m: Media;
  if (derived) {
    m = { format: MEDIA_FORMAT, dur: derived.video.dur, fps: derived.video.fps, width: derived.source.width,
          height: derived.source.height, base_lufs: derived.base_lufs, cuts: cutsAsSaved(derived.anchors.map((a) => a.t)),
          audio: req.audio, audio_bytes: req.audio_bytes, from: "analysis" };
    await putJson(j, prepKey(j, "media.json"), m);
  } else {
    const json = await readJson<unknown>(j, prepKey(j, "media.json"), MAX_MEDIA_BYTES);
    if (json === null) throw new ProduceError("the measurements of the video didn't arrive - measuring again", { status: 409, code: "stale" });
    m = parseMedia(json);
    if (m.audio !== req.audio || m.audio_bytes !== req.audio_bytes || m.from !== "browser") {
      throw new ProduceError("the measurements don't match the voiceover - measuring again", { status: 409, code: "stale" });
    }
  }
  return { ready: true, dur: m.dur, cuts: m.cuts.length };
}

// ------------------------------------------------------------------ transcribe

export type TranscribeResult = { words: number; language: string; cached: boolean };

const NO_SPEECH = "no speech was found in the video's sound. The voiceover is what gets translated: check that this video has one";

async function loadTranscript(j: PrepJob): Promise<Transcript | null> {
  const t = await readJson<Transcript>(j, prepKey(j, "transcript.json"), 20_000_000);
  return t && Array.isArray(t.words) ? t : null;
}

const wordCount = (t: Transcript) => t.words.filter((w) => (w.type ?? "word") === "word" && (w.text ?? "").trim()).length;

/** The voiceover transcribed (vt.transcribe), or the saved transcript. */
export async function transcribeStep(j: PrepJob, eleven: { apiKey: string; fetchFn?: typeof fetch; api?: string }): Promise<TranscribeResult> {
  if (j.status !== "preparing") throw new ProduceError("this project isn't being prepared", { status: 409, code: "gone" });
  const saved = await loadTranscript(j);
  if (saved) return { words: wordCount(saved), language: lang2(saved.language_code), cached: true };
  const m = await needMedia(j);
  const audio = await j.store.get(prepKey(j, m.audio), MAX_AUDIO_BYTES);
  if (!audio) throw new ProduceError("the voiceover went missing - measuring the video again", { status: 409, code: "stale" });
  const t = await transcribe(eleven.apiKey, audio, m.audio, AUDIO_FILES[m.audio], { fetchFn: eleven.fetchFn, api: eleven.api });
  await j.logUsage?.("elevenlabs_stt", { seconds: Math.round(m.dur * 10) / 10 }).catch(() => {});
  await putJson(j, prepKey(j, "transcript.json"), t);
  return { words: wordCount(t), language: lang2(t.language_code), cached: false };
}

// ------------------------------------------------------------------ names

export const NAMES_FORMAT = 1;
type Names = { format: number; base_lang: string; script: string; names_fixed: string[]; refused: boolean };

export type NamesStepResult = { changed: string[]; refused: boolean; cached: boolean };

/** The transcript's beats and its language (vt.cmd_analyze step 0). */
function fromTranscript(j: PrepJob, t: Transcript): { beats: string[]; lang: string } {
  const beats = splitBeats(scriptFromWords(t.words, ANALYZE.beat_pause));
  if (!beats.length) throw new ProduceError(NO_SPEECH);
  const lang = j.baseLang || lang2(t.language_code);
  if (!lang) throw new ProduceError("couldn't tell which language the voiceover is in");
  return { beats, lang };
}

async function loadNames(j: PrepJob): Promise<Names | null> {
  const n = await readJson<Names>(j, prepKey(j, "names.json"), 2_000_000);
  return n && n.format === NAMES_FORMAT && typeof n.script === "string" && Array.isArray(n.names_fixed) ? n : null;
}

/** Claude checks the spelling of names in the transcript (vt.fix_names), or the saved result. */
export async function namesStep(j: PrepJob, claude: ClaudeClient | null): Promise<NamesStepResult> {
  if (j.status !== "preparing") throw new ProduceError("this project isn't being prepared", { status: 409, code: "gone" });
  const saved = await loadNames(j);
  if (saved) return { changed: saved.names_fixed, refused: saved.refused, cached: true };
  const t = await loadTranscript(j);
  if (!t) throw new ProduceError("the voiceover isn't transcribed yet - transcribing it", { status: 409, code: "stale" });
  const { beats, lang } = fromTranscript(j, t);
  let names: Names;
  if (ANALYZE.fix_names && claude) {
    const { result, usage } = await checkNames(claude, beats, lang, j.reference);
    await j.logUsage?.("claude", usage as ClaudeUsage).catch(() => {});
    names = { format: NAMES_FORMAT, base_lang: lang, script: result.script, names_fixed: result.changed, refused: result.refused };
  } else {
    names = { format: NAMES_FORMAT, base_lang: lang, script: beats.join("\n\n") + "\n", names_fixed: [], refused: false };
  }
  await putJson(j, prepKey(j, "names.json"), names);
  return { changed: names.names_fixed, refused: names.refused, cached: false };
}

// ------------------------------------------------------------------ align

export type Prepared = { baseLang: string; script: string; namesFixed: string[]; warnings: string[] };
export type Aligned = { script: string; warnings: string[]; ok: boolean };
export type AlignResult = { status: "needs_review" | "producing"; warnings: string[] };

type SavedAlignment = Alignment & { _text?: string };

/** The forced alignment of `text` (vt.cmd_analyze step 1): the saved one when it was for the same text. */
async function alignment(j: PrepJob, m: Media, text: string, eleven: { apiKey: string; fetchFn?: typeof fetch; api?: string }): Promise<Alignment> {
  const saved = await readJson<SavedAlignment>(j, prepKey(j, "alignment.json"), 20_000_000);
  if (saved && saved._text === text && Array.isArray(saved.words)) return saved;
  const audio = await j.store.get(prepKey(j, m.audio), MAX_AUDIO_BYTES);
  if (!audio) throw new ProduceError("the voiceover went missing - measuring the video again", { status: 409, code: "stale" });
  const al = await forcedAlign(eleven.apiKey, audio, m.audio, AUDIO_FILES[m.audio], text, { fetchFn: eleven.fetchFn, api: eleven.api });
  await j.logUsage?.("elevenlabs_alignment", { seconds: Math.round(m.dur * 10) / 10 }).catch(() => {});
  await putJson(j, prepKey(j, "alignment.json"), { ...al, _text: text });
  return al;
}

/**
 * Time the transcript and write analysis.json (format 1, as vt.portable_analysis). While preparing, the transcript
 * is the one the name check left, and `prepared` hands it to the person for review. While aligning (an approved
 * transcript that was edited, or that an older worker made), it's the job's, and `aligned` either lets the job page
 * translate it or sends it back to the review, when the edits broke the timing (worker.Job.align).
 */
export async function alignStep(j: PrepJob, eleven: { apiKey: string; fetchFn?: typeof fetch; api?: string },
                                done: { prepared: (p: Prepared) => Promise<void>; aligned: (a: Aligned) => Promise<void> }): Promise<AlignResult> {
  const m = await needMedia(j);
  const video = { dur: m.dur, fps: m.fps, width: m.width, height: m.height, base_lufs: m.base_lufs };
  if (j.status === "preparing") {
    const names = await loadNames(j);
    if (!names) throw new ProduceError("the names aren't checked yet - checking them", { status: 409, code: "stale" });
    const beats = splitBeats(names.script);
    if (!beats.length) throw new ProduceError(NO_SPEECH);
    const al = await alignment(j, m, beats.join("\n\n"), eleven);
    // vt.prepare analyzes again after a name fix, and then reads the cuts back from cuts.txt (3 decimals)
    const A = analyzeVoiceover({ beats, alignment: al, cuts: names.names_fixed.length ? cutsAsSaved(m.cuts) : m.cuts, video, lang: names.base_lang });
    await putJson(j, analysisKey(j), A);
    await done.prepared({ baseLang: names.base_lang, script: A.beats.map((b) => b.text).join("\n\n"), namesFixed: names.names_fixed, warnings: A.warnings });
    return { status: "needs_review", warnings: A.warnings };
  }

  const wanted = splitBeats(j.script ?? "");
  if (!wanted.length) throw new ProduceError("the transcript is empty");
  if (!j.baseLang) throw new ProduceError("this project has no language for its voiceover. Upload the video again as a new project");
  const text = wanted.join("\n\n");
  // whether the analysis before this one had warnings, noted before analysis.json is replaced (a retry after a
  // failed save must decide the same way)
  const checkKey = prepKey(j, "align-check.json");
  const asked = JSON.stringify([text, j.warnings]);
  let check = await readJson<{ asked: string; had_warnings: boolean }>(j, checkKey, 2_000_000);
  if (!check || check.asked !== asked || typeof check.had_warnings !== "boolean") {
    const before = await savedAnalysis(j);
    check = { asked, had_warnings: j.warnings.length > 0 || (before?.warnings.length ?? 0) > 0 };
    await putJson(j, checkKey, check);
  }
  const hadWarnings = check.had_warnings;
  const al = await alignment(j, m, text, eleven);
  const A = analyzeVoiceover({ beats: wanted, alignment: al, cuts: cutsAsSaved(m.cuts), video, lang: j.baseLang });
  const ok = !(A.warnings.length && !hadWarnings); // stop before paying for voices on a bad alignment
  const warnings = ok ? A.warnings : [
    "After your edits, the transcript no longer matches the voiceover: " + A.warnings.join(" ") +
    " Only fix spelling; the words have to stay as spoken."];
  await putJson(j, analysisKey(j), A);
  await done.aligned({ script: A.beats.map((b) => b.text).join("\n\n"), warnings, ok });
  return { status: ok ? "producing" : "needs_review", warnings };
}
