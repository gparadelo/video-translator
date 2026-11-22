// The prepare half (lib/prepare: transcribe, the name check, forced alignment and the analysis) against
// scripts/vt.py, with no paid calls: vt.prepare (as the worker ran it) and the prepare steps run against the same fake
// ElevenLabs and Claude (test/mocks.mjs) on test videos (test/videos.mjs), and must send the same requests and end
// with the same analysis.json (vt.portable_analysis), transcript, names_fixed and warnings. The steps get what vt.py
// measured of each video (length, frame rate, size, cuts, loudness) and the audio it extracted, as prep/media.json and
// prep/audio.m4a, so this checks the server half alone; test/e2e checks what the browser measures. Timing an edited
// transcript again is compared with the worker's align (a spelling fix passes; changed words go back to review).
// Single functions (split_beats, script_from_words, norm, SequenceMatcher, the name check's prompt) are compared
// with vt.py's own answers.
//
// Needs ffmpeg and uv; skipped without them.

import Anthropic from "@anthropic-ai/sdk";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutsAsSaved, norm, scriptFromWords, splitBeats } from "../lib/prepare/analyze";
import { ANALYZE } from "../lib/prepare/config";
import { SequenceMatcher, stringRatio } from "../lib/prepare/difflib";
import { MEDIA_FORMAT, parseMedia, type Media } from "../lib/prepare/media";
import { NAMES_SCHEMA, NAMES_SYSTEM, namesPrompt } from "../lib/prepare/names";
import { alignStep, analysisKey, mediaStep, namesStep, prepKey, transcribeStep, type Aligned, type Links, type PrepJob, type Prepared } from "../lib/prepare/steps";
import { STT_MODEL } from "../lib/produce/config";
import { memoryStore } from "./produce-harness";
import { startMocks } from "./mocks.mjs";
import { makeVideo, SPOKEN } from "./videos.mjs";

const FIXTURE = resolve(__dirname, "prepare_fixture.py");
const has = (cmd: string, arg = "-version") => {
  try {
    execFileSync(cmd, [arg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ready = has("ffmpeg") && has("uv", "--version");
const UV = ["run", "-q", "--no-project", "--with", "requests", "--with", "anthropic", "python", FIXTURE];
const py = (args: string[], input?: string) => execFileSync("uv", [...UV, ...args], { encoding: "utf8", maxBuffer: 1 << 28, input });
/** The same without blocking: the fakes answer from this process. */
const pyAsync = (args: string[]) => new Promise<string>((res, rej) =>
  execFile("uv", [...UV, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }, (err, out, stderr) => (err ? rej(new Error(`${err.message}\n${stderr}`)) : res(out))));

type Mocks = Awaited<ReturnType<typeof startMocks>> & {
  requests: { service: string; path: string; body: Record<string, unknown>; audio?: { name: string; type: string; probe: { duration: number; channels: number } | null } }[];
};

const USER = "user-1", JOB = "job-1";
let runs = 0;

/** What the route would load: one project, in memory. */
function job(store: ReturnType<typeof memoryStore>, o: Partial<PrepJob> = {}): PrepJob {
  return { store, userId: USER, jobId: JOB, status: "preparing", baseLang: null, script: null, reference: null, warnings: [], analysisKey: null, ...o };
}
const json = (store: ReturnType<typeof memoryStore>, key: string) => JSON.parse(new TextDecoder().decode(store.files.get(key)!));

describe.skipIf(!ready)("lib/prepare against vt.py", () => {
  let dir: string;
  let m: Mocks;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vt-prepare-"));
    m = (await startMocks()) as Mocks;
  });
  afterAll(async () => {
    await m?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const claude = () => new Anthropic({ apiKey: "fake-claude-key", baseURL: m.claudeUrl, maxRetries: 0 });
  const eleven = () => ({ apiKey: "fake-eleven-key", api: m.elevenUrl });

  /** vt.prepare on `video`, then the same with the steps; both against the fakes. */
  async function both(name: string, reference: string | null, speech?: unknown) {
    const video = makeVideo(dir, name);
    m.setSpeech(speech);
    m.clear();
    const jobDir = join(dir, `vt-${name}-${++runs}`);
    const vt = JSON.parse(await pyAsync(["prepare", jobDir, video, "--eleven", m.elevenUrl,
                                         "--claude", m.claudeUrl, ...(reference ? ["--reference", reference] : [])]));
    const vtRequests = m.requests.splice(0);
    const measured = JSON.parse(py(["media", video]));
    const audio = readFileSync(vt.audio);
    const store = memoryStore();
    const media: Media = { format: MEDIA_FORMAT, dur: measured.dur, fps: measured.fps, width: measured.width, height: measured.height,
                           base_lufs: measured.base_lufs, cuts: measured.cuts, audio: "audio.m4a", audio_bytes: audio.length, from: "browser" };
    await store.put(prepKey(job(store), "media.json"), JSON.stringify(media), "application/json");
    await store.put(prepKey(job(store), "audio.m4a"), new Uint8Array(audio), "audio/mp4");
    const j = job(store, { reference });
    let prepared: Prepared | null = null;
    const usage: unknown[] = [];
    j.logUsage = async (service, amounts) => void usage.push({ service, ...amounts });
    const t = await transcribeStep(j, eleven());
    const n = await namesStep(j, claude());
    const a = await alignStep(j, eleven(), { prepared: async (p) => void (prepared = p), aligned: async () => { throw new Error("not aligning"); } });
    const ours = m.requests.splice(0);
    return { vt, vtRequests, ours, store, prepared: prepared as Prepared | null, t, n, a, usage, media, video, jobDir };
  }

  const fields = (rs: Mocks["requests"], path: string) => rs.filter((r) => r.path === path).map((r) => r.body);
  const claudeBodies = (rs: Mocks["requests"]) => rs.filter((r) => r.service === "claude").map((r) => r.body);

  for (const [name, reference] of [["cuts", "Nanoleaf lights"], ["cuts", null], ["ntsc", "Nanoleaf"], ["rotated", null], ["steps", "Nanoleaf"]] as const) {
    it(`${name}${reference ? " with names" : ""}: the same requests and analysis.json as vt.prepare`, async () => {
      const r = await both(name, reference);
      expect(r.vt.error).toBeNull();
      // the same analysis, to the last bit
      expect(json(r.store, analysisKey(job(r.store)))).toEqual(r.vt.analysis);
      expect(r.prepared).toEqual({ baseLang: r.vt.base_lang, script: r.vt.script, namesFixed: r.vt.names_fixed, warnings: r.vt.warnings });
      expect(r.vt.names_fixed.length > 0).toBe(reference !== null);
      expect(r.a).toEqual({ status: "needs_review", warnings: r.vt.warnings });
      // the same speech-to-text request, name check and (last) forced alignment
      expect(fields(r.ours, "/v1/speech-to-text")).toEqual(fields(r.vtRequests, "/v1/speech-to-text"));
      expect(fields(r.ours, "/v1/speech-to-text")).toEqual([{ model_id: STT_MODEL, tag_audio_events: "false", timestamps_granularity: "word" }]);
      expect(claudeBodies(r.ours)).toEqual(claudeBodies(r.vtRequests));
      const vtAligns = fields(r.vtRequests, "/v1/forced-alignment");
      expect(fields(r.ours, "/v1/forced-alignment")).toEqual(vtAligns.slice(-1)); // vt.py aligned twice when names were fixed
      expect(vtAligns.length).toBe(reference ? 2 : 1);
      // the audio sent is the voiceover: audio/mp4, mono, as long as the video
      for (const q of r.ours.filter((x) => x.audio)) {
        expect(q.audio!.type).toBe("audio/mp4");
        expect(q.audio!.probe!.channels).toBe(1);
        expect(Math.abs(q.audio!.probe!.duration - r.media.dur)).toBeLessThan(0.05);
      }
      // usage as the worker recorded it (one forced alignment less when names were fixed; the name check comes before
      // the alignment here), the same tokens for the name check
      type U = { service: string; input_tokens?: number };
      const vtUsage = (r.vt.usage as U[]).filter((u, i, all) =>
        u.service !== "elevenlabs_alignment" || i === all.map((x) => x.service).lastIndexOf("elevenlabs_alignment"));
      const sorted = (us: U[]) => us.map((u) => JSON.stringify(u)).sort();
      expect(sorted(r.usage as U[])).toEqual(sorted(vtUsage));
    });
  }

  it("asking again pays nothing", async () => {
    const r = await both("film", "Nanoleaf");
    const j = job(r.store, { reference: "Nanoleaf" });
    m.clear();
    expect((await transcribeStep(j, eleven())).cached).toBe(true);
    expect((await namesStep(j, claude())).cached).toBe(true);
    await alignStep(j, eleven(), { prepared: async () => {}, aligned: async () => {} });
    expect(m.requests).toEqual([]);
  });

  it("a name check that changes more than names is refused, as vt.py does", async () => {
    const words = SPOKEN.map(([text, start, end]) => ({ text: text === "welcome" ? "REWRITE" : text, start, end }));
    const r = await both("cuts", "Nanoleaf", { language_code: "eng", words });
    expect(r.vt.names_fixed).toEqual([]);
    expect(r.n).toEqual({ changed: [], refused: true, cached: false });
    expect(json(r.store, analysisKey(job(r.store)))).toEqual(r.vt.analysis);
  });

  it("a voiceover with no words fails with a plain message (vt.py crashed on it)", async () => {
    const store = memoryStore();
    const j = job(store);
    const media: Media = { format: MEDIA_FORMAT, dur: 2, fps: 30, width: 720, height: 1280, base_lufs: -70, cuts: [],
                           audio: "audio.m4a", audio_bytes: 0, from: "browser" };
    const audio = readFileSync(makeVideo(dir, "tiny")); // any file ffprobe reads as audio
    await store.put(prepKey(j, "media.json"), JSON.stringify({ ...media, audio_bytes: audio.length }), "application/json");
    await store.put(prepKey(j, "audio.m4a"), new Uint8Array(audio), "audio/mp4");
    m.setSpeech({ language_code: "eng", words: [] });
    expect((await transcribeStep(j, eleven())).words).toBe(0);
    await expect(namesStep(j, claude())).rejects.toThrow(/no speech was found/);
    m.setSpeech(undefined);
  });

  for (const [what, edit, ok] of [
    ["a spelling fix", (s: string) => s.replace("lights.", "lights!"), true],
    ["changed words", (s: string) => s.replace("Try them today!", "Try them today, tomorrow, and forever and ever!"), false],
  ] as const) {
    it(`an edited transcript timed again (${what}) as the worker's align`, async () => {
      const r = await both("cuts", "Nanoleaf lights");
      const script = edit(r.vt.script);
      expect(script).not.toBe(r.vt.script);
      m.clear();
      const vt = JSON.parse(await pyAsync(["align", r.jobDir, "--eleven", m.elevenUrl, "--script", script,
                                           "--warnings", JSON.stringify(r.vt.warnings)]));
      const vtRequests = m.requests.splice(0);
      const j = job(r.store, { status: "aligning", baseLang: r.vt.base_lang, script, warnings: r.vt.warnings,
                               analysisKey: analysisKey(job(r.store)) });
      let aligned: Aligned | null = null;
      const a = await alignStep(j, eleven(), { prepared: async () => { throw new Error("not preparing"); }, aligned: async (x) => void (aligned = x) });
      expect(vt.ok).toBe(ok);
      expect(aligned).toEqual({ script: vt.script, warnings: vt.warnings, ok: vt.ok });
      expect(a.status).toBe(ok ? "producing" : "needs_review");
      expect(json(r.store, analysisKey(j))).toEqual(vt.analysis);
      expect(fields(m.requests, "/v1/forced-alignment")).toEqual(fields(vtRequests, "/v1/forced-alignment"));
      // asked again (the save failed, say): the same decision, nothing paid
      m.clear();
      let again: Aligned | null = null;
      await alignStep(j, eleven(), { prepared: async () => {}, aligned: async (x) => void (again = x) });
      expect(again).toEqual(aligned);
      expect(m.requests).toEqual([]);
    });
  }

  it("media: links for the browser, then checks what arrived", async () => {
    const store = memoryStore();
    const j = job(store);
    const put: string[] = [];
    const links: Links = {
      put: async (key) => (put.push(key), `https://r2/${key}?put`),
      get: async (key) => `https://r2/${key}?get`,
      size: async (key) => (key.endsWith("/source") ? 1000 : store.files.get(key)?.length ?? null),
    };
    expect(await mediaStep(j, links, { phase: "start" })).toEqual({ ready: false, measure: true, source: `https://r2/u/${USER}/${JOB}/source?get` });
    const media: Media = { format: MEDIA_FORMAT, dur: 9, fps: 30, width: 1080, height: 1920, base_lufs: -20.1, cuts: [2.5, 4.2],
                           audio: "audio.m4a", audio_bytes: 3, from: "browser" };
    const up = await mediaStep(j, links, { phase: "upload", audio: "audio.m4a", audio_bytes: 3, media_bytes: 200 });
    expect(up).toEqual({ ready: false, uploads: { audio: `https://r2/${prepKey(j, "audio.m4a")}?put`, media: `https://r2/${prepKey(j, "media.json")}?put` } });
    await expect(mediaStep(j, links, { phase: "done", audio: "audio.m4a", audio_bytes: 3 })).rejects.toThrow(/didn't arrive/);
    await store.put(prepKey(j, "audio.m4a"), new Uint8Array([1, 2, 3]), "audio/mp4");
    await store.put(prepKey(j, "media.json"), JSON.stringify({ ...media, cuts: [4.2, 2.5] }), "application/json");
    await expect(mediaStep(j, links, { phase: "done", audio: "audio.m4a", audio_bytes: 3 })).rejects.toThrow(/out of order/);
    await store.put(prepKey(j, "media.json"), JSON.stringify(media), "application/json");
    expect(await mediaStep(j, links, { phase: "done", audio: "audio.m4a", audio_bytes: 3 })).toEqual({ ready: true, dur: 9, cuts: 2 });
    expect(await mediaStep(j, links, { phase: "start" })).toEqual({ ready: true, dur: 9, cuts: 2 });

    // a project an older worker analyzed: the measures come from its analysis.json, only the voiceover is needed
    const old = memoryStore();
    const k = job(old, { status: "aligning", analysisKey: analysisKey(job(old)) });
    const vtAnalysis = (await both("film", null)).vt.analysis;
    await old.put(analysisKey(k), JSON.stringify(vtAnalysis), "application/json");
    expect(await mediaStep(k, { ...links, size: async (key) => (key.endsWith("/source") ? 1 : old.files.get(key)?.length ?? null) }, { phase: "start" }))
      .toMatchObject({ ready: false, measure: false });
    await old.put(prepKey(k, "audio.wav"), new Uint8Array(10), "audio/wav");
    const done = await mediaStep(k, { ...links, size: async (key) => old.files.get(key)?.length ?? null }, { phase: "done", audio: "audio.wav", audio_bytes: 10 });
    expect(done).toEqual({ ready: true, dur: vtAnalysis.video.dur, cuts: vtAnalysis.anchors.length });
    expect(json(old, prepKey(k, "media.json")).cuts).toEqual(cutsAsSaved(vtAnalysis.anchors.map((a: { t: number }) => a.t)));
    // ...whose cuts, rounded as cuts.txt has them, may sit on 0.050 itself (the third frame at 59.94 fps)
    expect(parseMedia({ ...media, cuts: cutsAsSaved([3 / 59.94, 8.95]) }).cuts).toEqual([0.05, 8.95]);
    expect(() => parseMedia({ ...media, cuts: [0, 2] })).toThrow(/outside/);
    expect(() => parseMedia({ ...media, cuts: [2, 9] })).toThrow(/outside/);
    // the video gone from storage (30 days)
    await expect(mediaStep(job(memoryStore()), { ...links, size: async () => null }, { phase: "start" })).rejects.toThrow(/no longer in storage/);
  });

  it("single functions as vt.py's", () => {
    const texts = [
      "One. Two! Three? Four… five", "a\n\nb\n\n\nc", "line one\nline two\n", "  spaced   out  \n\n  x  ", "",
      "Mr. Smith goes. To Washington", "only one", "dup\r\n\r\ndup", "tabs\tand em spaces. ok",
    ];
    const words = [
      [{ text: "Hi", start: 0, end: 0.3 }, { text: " ", start: 0.3, end: 0.4, type: "spacing" }, { text: "there.", start: 0.4, end: 0.9 },
       { text: "Next", start: 1.0, end: 1.2 }, { text: "one", start: 2.3, end: 2.5 }, { text: "(laughs)", start: 2.6, end: 2.9, type: "audio_event" },
       { text: "end…", start: 3, end: 3.2 }, { text: "  ", start: 3.3, end: 3.4 }, { text: "x", start: 3.4, end: 3.5 }],
    ];
    const norms = ["Héllo,", "NANO-leaf", "ﬁne", "naïve", "1st", "ß", "Ångström", "—", "é", "日本語", "x_y"];
    const seqs: [string[], string[]][] = [
      [["a", "b", "c", "d"], ["a", "x", "c", "d"]], [["the", "cat", "the", "dog"], ["the", "dog", "the", "cat"]],
      [[], ["a"]], [["a", "a", "a"], ["a", "a"]],
      [Array.from({ length: 60 }, (_, i) => `w${i % 7}`), Array.from({ length: 55 }, (_, i) => `w${(i * 3) % 7}`)],
    ];
    const long = "a".repeat(150) + "bcd".repeat(40);
    const ratios: [string, string][] = [["Nano Leaf lights", "Nanoleaf lights"], ["Hello there", "Something else"], [long, long.replace("bcd", "xyz")],
                                        ["", ""], ["Ünïcode", "unicode"]];
    const calls = [
      ...texts.map((text) => ({ call: "split", text })),
      ...words.map((w) => ({ call: "words", words: w, pause: ANALYZE.beat_pause })),
      { call: "norm", words: norms },
      ...seqs.map(([a, b]) => ({ call: "blocks", a, b })),
      ...ratios.map(([a, b]) => ({ call: "ratio", a, b })),
      { call: "names_prompt", beats: ["Hello and welcome to Nano Leaf lights.", "Try them."], base_lang: "en", reference: "  Nanoleaf\n" },
      { call: "names_prompt", beats: ["Hola."], base_lang: "es", reference: null },
    ];
    const theirs = JSON.parse(py(["calls"], JSON.stringify(calls)));
    let k = 0;
    for (const t of texts) expect(splitBeats(t)).toEqual(theirs[k++]);
    for (const w of words) expect(scriptFromWords(w, ANALYZE.beat_pause)).toBe(theirs[k++]);
    expect(norms.map(norm)).toEqual(theirs[k++]);
    for (const [a, b] of seqs) expect(new SequenceMatcher(a, b, false).getMatchingBlocks()).toEqual(theirs[k++]);
    for (const [a, b] of ratios) expect(stringRatio(a.toLowerCase(), b.toLowerCase())).toBe(theirs[k++]);
    for (const c of calls.slice(-2) as { beats: string[]; base_lang: string; reference: string | null }[]) {
      const t = theirs[k++];
      expect(namesPrompt(c.beats, c.base_lang, c.reference)).toBe(t.prompt);
      expect(NAMES_SYSTEM).toBe(t.system);
      expect(NAMES_SCHEMA).toEqual(t.schema);
    }
  });

  it("the settings are config.default.toml's", () => {
    const toml = readFileSync(resolve(__dirname, "../../config.default.toml"), "utf8");
    const value = (key: string) => /^(\S+)/.exec(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m").exec(toml)![1])![1];
    expect(Number(value("scene_threshold"))).toBe(ANALYZE.scene_threshold);
    expect(Number(value("beat_pause"))).toBe(ANALYZE.beat_pause);
    expect(value("fix_names")).toBe(String(ANALYZE.fix_names));
    expect(JSON.parse(value("stt_model"))).toBe(STT_MODEL);
  });
});
