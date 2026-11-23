// The produce half (lib/produce: translation, Claude's rewrites, the voice) against the old Python pipeline, with no
// paid calls. The Python pipeline was run against the fake Claude and ElevenLabs (test/mocks.mjs) on synthetic
// analyses, and what it sent and made is frozen in test/fixtures/produce-parity.json (see "Tests" in web/README.md).
// The produce steps run here against the same fakes on the same analyses, and must send the same requests (Claude:
// every request body, in order; ElevenLabs: the same set of bodies) and end with the same files: the translation
// (script.json), every voice clip under the same name with the bytes the fake answered and the timing, and the plan
// inputs (inputs.json). Single functions (check_script, the cache key, json.dumps, prompts) are compared with the
// Python pipeline's frozen answers too, and the retries and messages are tested against queued failures.
//
// Needs ffmpeg (the fake ElevenLabs makes its voices with it); skipped without it.

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIT } from "../lib/pipeline/config";
import { pyFloatRepr, pyJsonDumps, pyRoundTo } from "../lib/pipeline/py";
import { CLAUDE, ELEVENLABS, KEY_PERMISSIONS } from "../lib/produce/config";
import { ProduceError } from "../lib/produce/errors";
import { outputKey, workKey } from "../lib/produce/keys";
import { produceLanguage, RunGone, RunTaken, TRIES, type Waiting } from "../lib/produce/run";
import { analysisId, mp3Duration, type Run } from "../lib/produce/steps";
import { briefTable, checkScript, langScript, LANG_NAMES, refitPrompt, SCRIPT_SCHEMA, TRANSLATE_SYSTEM } from "../lib/produce/translate";
import { ttsBody, ttsKey, voicedTexts } from "../lib/produce/tts";
import { parseAnalysis } from "../lib/produce/analysis";
import { fetchVia, memoryStore, type Backend } from "./produce-harness";
import { startMocks } from "./mocks.mjs"; // plain JavaScript, shared with test/e2e/run.mjs

const ready = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

type Request = { service: string; path: string; query: string; headers: Record<string, string>; body: Record<string, unknown> };
type Mocks = {
  claudeUrl: string; elevenUrl: string;
  requests: Request[];
  fail(service: "claude" | "eleven", ...answers: { status: number; body?: unknown; headers?: Record<string, string> }[]): void;
  voiceAudio(text: string, speed: number): Buffer | null;
  clear(): void; close(): Promise<void>;
};
type VtResult = {
  error: string | null; usage: Record<string, unknown>[]; script: { beats: unknown[] } | null; tts: string[];
  flags?: string[]; inputs?: unknown;
};
type FrozenCase = { seed: number; analysis: unknown; lang?: string; vt?: VtResult; metas?: Record<string, unknown>; requests?: Request[] };
const FROZEN: {
  cases: Record<string, FrozenCase>;
  calls: { items: unknown[]; answers: unknown[] }[];
  strings: Record<string, unknown> & { claude: Record<string, unknown> };
} = JSON.parse(readFileSync(resolve(__dirname, "fixtures/produce-parity.json"), "utf8"));

const USER = "user-1", JOB = "job-1", VOICE = "voice123456789", RUNNER = "browser-1";

describe.skipIf(!ready)("lib/produce against the frozen Python runs", () => {
  let dir = "";
  let m: Mocks;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vt-produce-"));
    m = (await startMocks()) as Mocks;
  }, 120_000);
  afterAll(async () => {
    await m?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A fake prepared job's analysis.json, as the frozen run had it. */
  const analysisOf = (name: string) => JSON.stringify(FROZEN.cases[name].analysis);

  function backend(analysis: string, langs: Record<string, number> = {}) {
    const store = memoryStore();
    store.files.set(`u/${USER}/${JOB}/analysis.json`, new TextEncoder().encode(analysis));
    const usage: { service: string; amounts: Record<string, unknown> }[] = [];
    const voiced: string[] = [];
    const runOf = (lang: string, generation: number): Run => ({
      store, userId: USER, jobId: JOB, lang, generation, voice: VOICE, analysisKey: `u/${USER}/${JOB}/analysis.json`,
      logUsage: async (service, amounts) => void usage.push({ service, amounts }),
    });
    const b: Backend = {
      run: (lang, generation) => (langs[lang] === undefined || langs[lang] === generation ? runOf(lang, generation) : null),
      claude: new Anthropic({ apiKey: "fake-claude-key", baseURL: m.claudeUrl, maxRetries: 0 }),
      eleven: { apiKey: "fake-eleven-key", api: m.elevenUrl },
      markVoiced: async (run) => void voiced.push(`${run.lang}:${run.generation}`),
    };
    return { b, store, usage, voiced };
  }

  const json = (store: ReturnType<typeof memoryStore>, key: string) => {
    const f = store.files.get(key);
    return f ? JSON.parse(new TextDecoder().decode(f)) : null;
  };
  const noSleep = async () => {};
  const sorted = <T>(xs: T[]) => [...xs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  async function compareWithFrozen(name: string) {
    const frozen = FROZEN.cases[name];
    const vt = frozen.vt!, lang = frozen.lang!, vtReqs = frozen.requests!;
    m.clear();
    const { b, store, usage, voiced } = backend(analysisOf(name));
    let error: string | null = null;
    try {
      await produceLanguage({ jobId: JOB, runner: RUNNER, lang, generation: 1, fetchFn: fetchVia(b), sleep: noSleep });
    } catch (e) {
      error = (e as Error).message;
    }
    const ourReqs = m.requests.splice(0);

    expect(error, `${name}: the outcome`).toBe(vt.error);
    // Claude: the same requests, in the same order
    const claude = (rs: Request[]) => rs.filter((r) => r.service === "claude");
    expect(claude(ourReqs).map((r) => r.body), `${name}: Claude requests`).toEqual(claude(vtReqs).map((r) => r.body));
    for (const r of claude(ourReqs)) expect(r.headers["anthropic-beta"]).toContain(CLAUDE.betas[0]);
    expect(claude(vtReqs)[0]?.headers["anthropic-beta"]).toContain(CLAUDE.betas[0]);
    // ElevenLabs: the same requests (several at once here, so in any order)
    const eleven = (rs: Request[]) => sorted(rs.filter((r) => r.service === "eleven").map((r) => ({ path: r.path, query: r.query, body: r.body, key: r.headers["xi-api-key"] })));
    expect(eleven(ourReqs), `${name}: ElevenLabs requests`).toEqual(eleven(vtReqs));
    // the same clips, under the same names, with the bytes the fake answered and the same timing
    const prefix = workKey(USER, JOB, lang, "tts/");
    const ours = [...store.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
    expect(ours, `${name}: clips`).toEqual(vt.tts);
    const answered = new Map<string, Buffer>();
    for (const r of ourReqs.filter((q) => q.service === "eleven")) {
      const body = r.body as Parameters<typeof ttsKey>[1];
      const audio = m.voiceAudio(body.text, body.voice_settings.speed);
      if (audio) answered.set(`${ttsKey(VOICE, body)}.mp3`, audio);
    }
    for (const f of vt.tts) {
      const mine = store.files.get(prefix + f)!;
      if (f.endsWith(".mp3")) {
        expect(answered.get(f) && Buffer.from(mine).equals(answered.get(f)!), `${name}: ${f}`).toBe(true);
        // its length from the header, as ffprobe gives it
        const path = join(dir, f);
        writeFileSync(path, mine);
        const probed = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }));
        expect(mp3Duration(mine), `${name}: ${f} length`).toBe(probed);
      }
      else expect(JSON.parse(new TextDecoder().decode(mine)), `${name}: ${f}`).toEqual(frozen.metas![f]);
    }
    // the translation, and usage (Claude's token counts depend on how each SDK writes JSON: not compared)
    const script = json(store, workKey(USER, JOB, lang, "script.json"));
    if (vt.script) expect(script?.beats, `${name}: script.json`).toEqual(vt.script.beats);
    const services = (u: { service: string; amounts: Record<string, unknown> }[]) =>
      sorted(u.map((x) => (x.service === "claude" ? { service: "claude", model: x.amounts.model } : x)));
    expect(services(usage), `${name}: usage`).toEqual(services(vt.usage.map(({ service, ...amounts }) => ({ service: String(service), amounts }))));
    // the plan inputs
    if (vt.inputs) {
      expect(json(store, outputKey(USER, JOB, lang, 1, "inputs.json")), `${name}: inputs.json`).toEqual(vt.inputs);
      expect(voiced).toEqual([`${lang}:1`]);
      for (const c2 of (vt.inputs as { clips: { file: string }[] }).clips) {
        expect(store.files.has(outputKey(USER, JOB, lang, 1, `tts/${c2.file}`))).toBe(true);
        expect(store.files.has(outputKey(USER, JOB, lang, 1, `tts/${c2.file.replace(".mp3", ".json")}`))).toBe(true);
      }
    } else expect(voiced).toEqual([]);
    return { vt, vtReqs, ourReqs, store, b };
  }

  it("translates, voices and fits as the Python pipeline did (re-asks, rewrite rounds, speeds)", async () => {
    let rewrites = 0, reasks = 0, flagged = 0;
    for (let i = 0; i < 6; i++) {
      const { vtReqs, vt } = await compareWithFrozen(`case${i}`);
      const firsts = vtReqs.filter((r) => r.service === "claude").map((r) => (r.body.messages as { content: string }[]));
      rewrites += firsts.filter((ms) => ms[0].content.startsWith("Here is the original")).length;
      reasks += firsts.filter((ms) => ms.length > 1).length;
      flagged += vt.flags?.length ? 1 : 0;
    }
    // the cases did exercise the loop: re-asks, rewrites, and rewrites that never helped (voiced with flags left)
    expect(rewrites).toBeGreaterThan(CLAUDE.fix_rounds);
    expect(reasks).toBeGreaterThan(0);
    expect(flagged).toBeGreaterThan(0);
    console.log(`produce parity: ${rewrites} rewrites, ${reasks} re-asks, ${flagged} languages still flagged after the last round`);
  }, 600_000);

  it("fails as the Python pipeline did when Claude never gets the markers right", async () => {
    const { vt } = await compareWithFrozen("broken");
    expect(vt.error).toMatch(/still has problems after 3 tries/);
  }, 120_000);

  it("carries on after a stop without paying twice, and a new run reuses everything", async () => {
    const analysis = analysisOf("resume");
    const full = backend(analysis);
    m.clear();
    await produceLanguage({ jobId: JOB, runner: RUNNER, lang: "de", generation: 1, fetchFn: fetchVia(full.b), sleep: noSleep });
    const all = m.requests.splice(0);
    const want = json(full.store, outputKey(USER, JOB, "de", 1, "inputs.json"));

    // stopped after the third voice clip, then started again (the page reopened)
    const { b, store } = backend(analysis);
    const ac = new AbortController();
    let clips = 0;
    await expect(produceLanguage({
      jobId: JOB, runner: RUNNER, lang: "de", generation: 1, signal: ac.signal, sleep: noSleep,
      fetchFn: fetchVia(b, (path) => path.endsWith("/tts") && ++clips === 3 && ac.abort()),
    })).rejects.toThrow();
    await produceLanguage({ jobId: JOB, runner: RUNNER, lang: "de", generation: 1, fetchFn: fetchVia(b), sleep: noSleep });
    const again = m.requests.splice(0);
    expect(json(store, outputKey(USER, JOB, "de", 1, "inputs.json"))).toEqual(want);
    const bodies = (rs: typeof all, s: string) => sorted(rs.filter((r) => r.service === s).map((r) => r.body));
    expect(bodies(again, "claude")).toEqual(bodies(all, "claude")); // each Claude call once
    expect(bodies(again, "eleven")).toEqual(bodies(all, "eleven")); // each clip once

    // a second run (Try again, or the language asked for again): nothing paid, the same inputs
    await produceLanguage({ jobId: JOB, runner: RUNNER, lang: "de", generation: 2, fetchFn: fetchVia(b), sleep: noSleep });
    expect(m.requests.splice(0)).toEqual([]);
    expect(json(store, outputKey(USER, JOB, "de", 2, "inputs.json"))).toEqual(want);
  }, 300_000);

  it("tries passing problems again, with pauses, and stops with a plain message on the others", async () => {
    const analysis = analysisOf("errors");
    const run = async (lang = "es", generation = 1, backendOf = backend(analysis)) => {
      const waits: Waiting[] = [];
      const slept: number[] = [];
      try {
        await produceLanguage({ jobId: JOB, runner: RUNNER, lang, generation, fetchFn: fetchVia(backendOf.b), onWaiting: (w) => waits.push(w),
                                sleep: async (ms) => void slept.push(ms) });
        return { error: null, waits, slept };
      } catch (e) {
        return { error: e as Error, waits, slept };
      }
    };
    m.clear();
    // busy, then overloaded: both pass
    m.fail("eleven", { status: 429, body: { detail: { status: "too_many_concurrent_requests", message: "Too many concurrent requests" } }, headers: { "retry-after": "7" } },
                     { status: 503 });
    m.fail("claude", { status: 529 }, { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } });
    let r = await run();
    expect(r.error).toBeNull();
    expect(r.waits.filter(Boolean).map((w) => w!.reason)).toEqual(expect.arrayContaining([
      "ElevenLabs is busy (too many requests at once) - trying again", "ElevenLabs is having problems (503) - trying again",
      "the Claude API is having problems (529) - trying again", "Claude is busy (too many requests) - trying again"]));
    expect(Math.max(...r.slept)).toBeGreaterThanOrEqual(7 * 0.8 * 1000); // Retry-After is honoured

    // the key problems, each one stopping the language with its message
    const cases: [string, number, unknown, RegExp][] = [
      ["eleven", 401, { detail: { status: "missing_permissions", message: "The API key you used is missing the permission text_to_speech to execute this operation." } },
       /^TTS failed: your ElevenLabs API key is missing the 'Text to Speech' permission\. Edit the key at elevenlabs\.io \(Developers -> API keys\) and enable: Text to Speech, Speech to Text, Forced Alignment\.$/],
      ["eleven", 401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }, /^TTS failed: ElevenLabs rejected the API key \(401\)\. Check it in Settings/],
      ["eleven", 401, { detail: { status: "quota_exceeded", message: "This request exceeds your quota of 10000." } }, /doesn't have enough credits left/],
      ["eleven", 404, { detail: { status: "voice_not_found", message: "A voice with the voice_id was not found." } }, /has no voice voice123456789 in your account/],
      ["claude", 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, /^the Claude API rejected your Claude API key \(401\) - check it in Settings$/],
      ["claude", 400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, /out of credits/],
    ];
    for (const [i, [service, status, body, msg]] of cases.entries()) {
      m.clear();
      m.fail(service as "claude" | "eleven", { status, body });
      r = await run(["it", "nl", "pt", "pl", "sv", "fi"][i], 1); // a language not made yet, so the call is made
      expect(r.error, `${service} ${status}`).toBeInstanceOf(ProduceError);
      expect(r.error!.message).toMatch(msg);
    }

    // a problem that doesn't pass: given up after TRIES tries
    m.clear();
    m.fail("eleven", ...Array.from({ length: 100 }, () => ({ status: 503 })));
    r = await run("da", 1);
    expect(r.error?.message).toBe("ElevenLabs is having problems (503) - trying again");
    expect(r.slept.length).toBeGreaterThanOrEqual(TRIES - 1);
    m.clear();

    // a run that is over (canceled, started again): stops quietly
    const gone = backend(analysis, { es: 2 });
    r = await run("es", 1, gone);
    expect(r.error).toBeInstanceOf(RunGone);

    // a run another browser holds (hold_run): stops before anything is paid for
    m.clear();
    const taken = backend(analysis);
    taken.b.holder = () => "another-browser";
    r = await run("ro", 1, taken);
    expect(r.error).toBeInstanceOf(RunTaken);
    expect(m.requests).toEqual([]);
  }, 300_000);
});

describe("single functions against the Python pipeline's frozen answers", () => {
  /** The Python pipeline's answers to exactly these calls, as frozen. */
  const calls = (items: unknown[]) => {
    const frozen = FROZEN.calls.find((f) => isDeepStrictEqual(f.items, JSON.parse(JSON.stringify(items))));
    if (!frozen) throw new Error("these calls have no frozen answers (test/fixtures/produce-parity.json)");
    return frozen.answers as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it("has the Python pipeline's prompts, schema, language names and settings", () => {
    const s = FROZEN.strings;
    expect(TRANSLATE_SYSTEM).toBe(s.translate_system);
    expect(SCRIPT_SCHEMA).toEqual(s.script_schema);
    expect(LANG_NAMES).toEqual(s.lang_names);
    expect({ model: CLAUDE.model, effort: CLAUDE.effort, fix_rounds: CLAUDE.fix_rounds }).toEqual(
      { model: s.claude.model, effort: s.claude.effort, fix_rounds: s.claude.fix_rounds });
    expect(ELEVENLABS).toEqual(s.elevenlabs);
    expect(FIT).toEqual(s.fit);
    expect(KEY_PERMISSIONS).toEqual(s.key_permissions);
  });

  it("writes JSON and floats like Python", () => {
    const strings = ["plain", "Grüße — “quoted” \"x\" \\ back", "tab\tnew\nline\r\u0001\u007f", "emoji 🎬 ok", "日本語", ""];
    const floats = [0, 1, 1.0, 0.5, 0.75, 1.2, 0.7, 1.05, 1.333, 0.1 + 0.2, 1e-5, 1.5e-7, 123456789012345680, 1e16, 2.5e21, -0.25, 100];
    const [dumped, reprs] = calls([{ call: "dumps", value: [strings, { b: 1.5, a: [true, false, null], "ü": "x" }] }, { call: "repr", values: floats }]);
    // every number as a float, as in the cache key: Python's ints are written without ".0", so compare the strings
    expect(pyJsonDumps([strings, { b: 1.5, a: [true, false, null], "ü": "x" }])).toBe(dumped);
    expect(floats.map(pyFloatRepr)).toEqual(reprs);
    const values = [1.333, 1.335, 1.345, 0.705, 1.125, 0.6, 1.3, 1.0049999, 1.015];
    expect(values.map((v) => pyRoundTo(Math.max(0.7, Math.min(1.2, v)), 2))).toEqual(calls([{ call: "round2", values }])[0]);
  });

  it("makes the Python pipeline's TTS request bodies and cache keys", () => {
    const texts = ["Hallo zusammen — “Lumen” ist da.", "Ein Satz mit Ümlaut und ß.", "Kurz.", "🎬 Szene drei", "Fin"];
    const items = [];
    for (const [i] of texts.entries()) {
      for (const speed of [null, 0.6, 1.0, 1.08, 1.33, 1.2]) {
        for (const model_id of ["eleven_multilingual_v2", "eleven_flash_v2_5"]) items.push({ call: "tts", voice: VOICE, texts, i, lang: "de", speed, model_id });
      }
    }
    const theirs = calls(items);
    items.forEach((c, k) => {
      const el = { ...ELEVENLABS, model_id: c.model_id };
      const body = ttsBody(c.texts, c.i, c.lang, c.speed, el);
      expect(body, `${k}`).toEqual(theirs[k].body);
      expect(ttsKey(c.voice, body), `${k}`).toBe(theirs[k].key);
      expect(body.voice_settings.speed).toBe(theirs[k].speed);
      expect(theirs[k].params).toEqual({ output_format: ELEVENLABS.output_format });
      expect(theirs[k].url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps`);
    });
    expect(voicedTexts([{ text: " {1}Hallo  {2}Welt \n" }])).toEqual(["Hallo  Welt"]);
  });

  it("checks translations, writes script.json and builds prompts like the Python pipeline", () => {
    const base = [
      { id: 1, text: "Meet Lumen.", marked: "{1}Meet Lumen.", dur: 1.234, pause_after: 0.3 },
      { id: 2, text: "It turns every room warm — fast.", marked: "It turns {2}every {3}{4}room warm — fast.", dur: 2.5, pause_after: 0.1 },
      { id: 3, text: "Grüße", marked: "Grüße{5}", dur: 0.61, pause_after: 0 },
    ];
    const tries = [
      [{ id: 1, text: "{1}Voilà Lumen." }, { id: 2, text: "Il {2}rend {3}{4}chaque pièce." }, { id: 3, text: "Salut{5}" }],
      [{ id: 1, text: "Voilà Lumen." }, { id: 2, text: "Il {2}{2}rend {9}{4}chaque pièce." }, { id: 3, text: "  {5} " }],
      [{ id: 1, text: "{1}a" }, { id: 3, text: "b" }],
      [{ id: 2, text: "{1}a" }, { id: 1, text: "b" }, { id: 3, text: "c" }],
    ];
    const answers = calls([
      ...tries.map((beats) => ({ call: "check", base, beats })),
      { call: "brief", beats: base },
      { call: "script", beats: [{ id: 1, text: "  hi  ", speed: 1.333 }, { id: 2, text: "x\n", speed: null }, { id: 3, text: "y", speed: 0.5 }] },
    ]);
    tries.forEach((beats, k) => expect(checkScript(base, beats), `try ${k}`).toEqual(answers[k]));
    expect(briefTable(base)).toBe(answers[tries.length]);
    expect(langScript([{ id: 1, text: "  hi  ", speed: 1.333 }, { id: 2, text: "x\n", speed: null }, { id: 3, text: "y", speed: 0.5 }]))
      .toEqual(answers[tries.length + 1]);

    const script = [{ id: 1, text: "{1}Voilà", speed: 1.1 }, { id: 2, text: "Il {2}rend {3}{4}chaque pièce" }, { id: 3, text: "Salut{5}", speed: 1.0 }];
    const plan = {
      beats: [{ dur: 1.5, base_dur: 1.234 }, { dur: 2.0, base_dur: 2.5 }, { dur: 0.7, base_dur: 0.61 }],
      flags: [{ beat: 2, cut: 3, msg: "cut 3 (at 2.0s) lands 0.40s after its word: beat 2 is ~0.20s too short" },
              { beat: null, cut: 9, msg: "marker {9} is missing in the translation - cut placed by interpolation" },
              { beat: 1, cut: 1, msg: "x" }, { beat: 2, cut: 4, msg: "y" }],
    };
    const [prompt] = calls([{ call: "refit", base, base_lang: "en", lang: "fr", script, plan }]);
    const A = parseAnalysis({ format: 1, base_lang: "en", video: { dur: 5, fps: 30 }, source: { width: 1080, height: 1920 },
      speech_start: 0.2, speech_end: 4, base_lufs: -16, beats: base, tokens: [{ beat: 0 }], anchors: [] });
    expect(refitPrompt(A, "fr", script, plan as never)).toBe(prompt);
    expect(analysisId(A)).toMatch(/^[0-9a-f]{16}$/);
  });
});
