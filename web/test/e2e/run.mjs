// End-to-end check in a real browser (Google Chrome, headless), no network and no paid APIs. What the old Python
// pipeline made for the same jobs is frozen in test/fixtures/e2e.json (see "Tests" in web/README.md); the reference
// renders are made here with ffmpeg alone from the frozen plans (test/reference.mjs: the same clip-by-clip ffmpeg
// commands the old CLI render used).
//   1. makes two fake jobs from the frozen fixtures: a synthetic 12 s 1080x1920 30 fps video with frame numbers
//      drawn in, each job's plan inputs and fake TTS clips (made with ffmpeg), and the reference render of the
//      "flat" one (ffmpeg, from its frozen plan.json),
//   2. in Chrome, builds each job's plan.json and voice.wav from its plan inputs with lib/pipeline (the clips
//      decoded by the browser) and checks them against the frozen plan and ffmpeg's voice track of it,
//   3. renders the "flat" job (every tempo 1) from what the browser built with lib/render, the source read with
//      range requests, and checks every output frame shows the same source frame as the reference render, and that
//      the voice lines up. The "stretched" job (a beat's tempo isn't 1: WSOLA here, atempo in ffmpeg) is checked
//      beat by beat in step 2.
//   4. an approved job, all the way: in Chrome, the job page's produce code (lib/produce/run.ts) translates,
//      voices and fits its language through the produce routes (served here by lib/produce/steps.ts, with the
//      fake Claude and ElevenLabs of test/mocks.mjs) until it is voiced; its requests and plan inputs must be the
//      frozen ones, then the browser builds its plan and voice and renders it, checked against ffmpeg's render of
//      the frozen plan.
//   5. a new video, all the way: the file checks on test videos (test/videos.mjs: HDR, variable frame rate,
//      rotated, no sound, codecs Chrome can't decode, too short), what the browser measures of them (length,
//      frame rate, size, cuts and loudness against ffprobe/ffmpeg, the voiceover's sound against ffmpeg's), then
//      one is uploaded and prepared through the prepare routes (lib/prepare/run.ts against lib/prepare/steps.ts and
//      the fakes) to its analysis.json, which must be the frozen one; its transcript is edited and timed again (read
//      back from storage this time); then it is produced ("de"), built and rendered as in step 4.
//
//   pnpm e2e [--modes preview,original,720p] [--chrome /path/to/chrome] [--headed] [--keep] [--bench]
//
// Needs ffmpeg and Chrome (CHROME_PATH or --chrome; defaults to the usual macOS location).

import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { startMocks } from "../mocks.mjs";
import { compareRender, frameVideo, media, renderReference, toneClip, voiceover, voiceTrack } from "../reference.mjs";
import { makeVideo, VIDEOS } from "../videos.mjs";

const here = resolve(import.meta.dirname);
const { values: opt } = parseArgs({
  options: {
    modes: { type: "string", default: "preview,original,720p" },
    chrome: { type: "string", default: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    headed: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    // also time the measuring of a 2-minute 4K and a 2-minute 1080p portrait video (no checks; prints the times)
    bench: { type: "boolean", default: false },
  },
});

const FROZEN = JSON.parse(readFileSync(join(here, "..", "fixtures", "e2e.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "vt-e2e-"));
console.log(`fixture jobs in ${dir}`);

/** A frozen plan's reference: its voice track (ffmpeg, from the clips in `clipDir`) and plan in `folder`, as files. */
function referenceOf(folder, plan, clipDir, baseLufs) {
  const missing = plan.beats.map((b) => b.audio).filter((f) => !existsSync(join(clipDir, f)));
  if (missing.length) throw new Error(`FAIL: the clips the frozen plan uses weren't made (${missing.join(", ")}): the voice requests differ`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "plan_web.json"), JSON.stringify(plan));
  voiceTrack(plan, clipDir, baseLufs, join(folder, "voice.wav"));
  return { plan: join(folder, "plan_web.json"), voice: join(folder, "voice.wav") };
}

// 1: the source video, the two jobs' plan inputs and clips, and the reference render of the "flat" one
const sourcePath = frameVideo(join(dir, "source.mp4"), { rate: "30", seconds: 12, size: [1080, 1920] });
const files = { "source.mp4": sourcePath };
const jobs = {};
for (const name of ["flat", "stretched"]) {
  const f = FROZEN[name];
  const tts = join(dir, name, "tts");
  mkdirSync(tts, { recursive: true });
  writeFileSync(join(dir, name, "inputs.json"), JSON.stringify(f.inputs));
  files[`${name}/inputs.json`] = join(dir, name, "inputs.json");
  for (const [file, k] of Object.entries(f.clips)) {
    const meta = file.replace(/\.mp3$/, ".json");
    toneClip(join(tts, file), k.tone.spans, k.tone.dur, k.tone.freq, k.tone.level_db);
    writeFileSync(join(tts, meta), JSON.stringify(k.meta));
    files[`${name}/tts/${file}`] = join(tts, file);
    files[`${name}/tts/${meta}`] = join(tts, meta);
  }
  jobs[name] = referenceOf(join(dir, name, "reference"), f.plan, tts, f.inputs.analysis.base_lufs);
}
const reference = renderReference(FROZEN.flat.plan, sourcePath, jobs.flat.voice, join(dir, "flat-reference.mp4"));
const ranges = [];

// 5: test videos and the new-upload job
const videoDir = join(dir, "videos");
mkdirSync(videoDir, { recursive: true });
const MEASURED = ["cuts", "steps", "ntsc", "film", "sixty", "rotated", "rotated180"];
const CHECKED = Object.keys(VIDEOS);
for (const n of CHECKED) files[`videos/${n}.mp4`] = makeVideo(videoDir, n);
const BENCH = opt.bench ? { bench4k: "2160x3840", bench1080: "1080x1920" } : {};
for (const [n, size] of Object.entries(BENCH)) {
  files[`videos/${n}.mp4`] = join(videoDir, `${n}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${size}:r=30:d=120`, "-f", "lavfi", "-i", "sine=f=220:d=120",
                          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", files[`videos/${n}.mp4`]]);
}
const UPLOAD = { userId: "user-up", jobId: "job-upload", voice: "voice123456789", video: "cuts", reference: "Nanoleaf lights" };

// 4: the approved job, on the same video as the others: a job where Claude rewrote beats and every beat ends at
// tempo 1 (so the render's voice can be compared sample for sample with the reference's), with the analysis, the
// requests, the plan inputs and the plan the Python pipeline had for it (frozen)
const mocks = await startMocks();
const vtProduced = FROZEN.produced;
const vtRequests = vtProduced.requests;
const store = join(dir, "store");
const PRODUCED = { userId: "user-e2e", jobId: "job-e2e", voice: "voice123456789" };
const runFolder = join(store, "u", PRODUCED.userId, PRODUCED.jobId, "out", "de", "g1");
const uploadRunFolder = join(store, "u", UPLOAD.userId, UPLOAD.jobId, "out", "de", "g1");
mkdirSync(join(store, "u", PRODUCED.userId, PRODUCED.jobId), { recursive: true });
writeFileSync(join(store, "u", PRODUCED.userId, PRODUCED.jobId, "analysis.json"), JSON.stringify(vtProduced.analysis));

// Serves the fixture files with HTTP range support (like R2) and takes the browser's files back.
const fixtureFiles = {
  name: "fixture-files",
  configureServer(server) {
    const backends = {};
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/favicon.ico") return void (res.statusCode = 204, res.end());
      // the prepare routes of the new-upload job, as app/api/jobs/<id>/prepare/* answer them
      if (url.pathname.startsWith(`/api/jobs/${UPLOAD.jobId}/prepare/`) && req.method === "POST") {
        const parts = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", async () => {
          const { status, json } = await (await prepared()).handle(url.pathname, JSON.parse(Buffer.concat(parts).toString() || "{}"));
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(json));
        });
        return;
      }
      // the signed upload links of the prepare routes: into the store, as R2 would
      if (url.pathname.startsWith("/upload/") && req.method === "PUT") {
        const key = url.pathname.slice(8);
        if (key.split("/").includes("..")) return void (res.statusCode = 400, res.end());
        const parts = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", () => {
          mkdirSync(dirname(join(store, key)), { recursive: true });
          writeFileSync(join(store, key), Buffer.concat(parts));
          res.end();
        });
        return;
      }
      // the produce routes of the "produced" and the new-upload jobs, as app/api/jobs/<id>/produce/<lang>/* answer them
      const job = [PRODUCED, UPLOAD].find((j) => url.pathname.startsWith(`/api/jobs/${j.jobId}/produce/`));
      if (job && req.method === "POST") {
        const parts = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", async () => {
          try {
            const h = await server.ssrLoadModule(resolve(here, "..", "produce-harness.ts"));
            backends[job.jobId] ??= h.folderBackend({ root: store, ...job, claudeUrl: mocks.claudeUrl, elevenUrl: mocks.elevenUrl });
            const { status, json } = await h.handleStep(backends[job.jobId].b, url.pathname, JSON.parse(Buffer.concat(parts).toString() || "{}"));
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(json));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
        return;
      }
      if (url.pathname.startsWith("/files/")) {
        const rel = url.pathname.slice(7);
        // what the produce routes wrote for the "produced" job's run (the store is R2 here)
        const under = (prefix, folder) => rel.startsWith(prefix) && !rel.includes("..") && existsSync(join(folder, rel.slice(prefix.length)))
          ? join(folder, rel.slice(prefix.length)) : null;
        const path = files[rel] ?? under("produced/", runFolder) ?? under("uploaded/", uploadRunFolder) ?? under("store/", store);
        if (!path) return void (res.statusCode = 404, res.end());
        const size = statSync(path).size;
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        res.setHeader("Accept-Ranges", "bytes");
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          ranges.push([url.pathname, start, end]);
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", end - start + 1);
          return void createReadStream(path, { start, end }).pipe(res);
        }
        res.setHeader("Content-Length", size);
        return void createReadStream(path).pipe(res);
      }
      if (url.pathname.startsWith("/save/") && req.method === "POST") {
        const parts = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", () => {
          writeFileSync(join(dir, url.pathname.slice(6)), Buffer.concat(parts));
          res.end("ok");
        });
        return;
      }
      next();
    });
  },
};

/** 16-bit PCM samples of a WAV file (the data chunk). */
function wavSamples(path) {
  const b = readFileSync(path);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("latin1", at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + (size & ~1)));
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no audio`);
}

/** Differences between two JSON values: integers exactly, other numbers within 1e-9. */
function jsonDiffs(a, b, path = "", out = []) {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isInteger(a) && Number.isInteger(b) ? a !== b : Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b))) out.push(`${path}: ${a} vs ${b}`);
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) jsonDiffs(a[k], b[k], `${path}.${k}`, out);
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

/** The browser's voice.wav against ffmpeg's: outside stretched beats sample by sample, stretched beats by level. */
function voiceParity(name, j) {
  const got = wavSamples(join(dir, `${name}-voice.wav`)), want = wavSamples(j.voice);
  const plan = JSON.parse(readFileSync(join(dir, `${name}-plan.json`), "utf8"));
  const spans = plan.beats.filter((b) => b.tempo !== 1).map((b) => {
    const at = Math.round(b.offset * 44100) + 219;
    return [at - 2048, at + Math.round(b.dur * 44100) + 2048];
  });
  // a stretched beat changes the measured loudness a little; when it rounds (to 0.1 LU, as ebur128 prints it) the other
  // way, the whole track is 0.1 dB louder or quieter (see test/pipeline-parity.test.ts)
  let xy = 0, yy = 0;
  for (let k = 0; k < want.length / 2; k++) {
    if (spans.some(([a, z]) => k >= a && k < z)) continue;
    xy += got[2 * k] * want[2 * k];
    yy += want[2 * k] ** 2;
  }
  const ratio = yy ? xy / yy : 1;
  const scale = [1, 10 ** (0.1 / 20), 10 ** (-0.1 / 20)].reduce((a, b) => (Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a));
  let maxDiff = spans.length || scale === 1 ? 0 : Infinity; // without stretched beats the gain must be the same
  const levels = spans.map(() => [0, 0]);
  for (let k = 0; k < want.length / 2; k++) {
    const s = spans.findIndex(([a, z]) => k >= a && k < z);
    if (s < 0) maxDiff = Math.max(maxDiff, Math.abs(got[2 * k] - Math.round(want[2 * k] * scale)));
    else {
      levels[s][0] += got[2 * k] ** 2;
      levels[s][1] += want[2 * k] ** 2;
    }
  }
  return { sameLength: got.length === want.length, maxDiff, gainStep: scale !== 1,
           levels: levels.map(([g, w]) => 10 * Math.log10(g / w)) };
}

/** The new-upload job's prepare backend (test/prepare-harness.ts), made once. */
let prepareBackend = null;
async function prepared() {
  if (!prepareBackend) {
    const h = await server.ssrLoadModule(resolve(here, "..", "prepare-harness.ts"));
    prepareBackend = h.prepareBackend({ root: store, ...UPLOAD, claudeUrl: mocks.claudeUrl, elevenUrl: mocks.elevenUrl });
  }
  return prepareBackend;
}

/** Mono samples of an audio file, as ffmpeg decodes it. */
function monoSamples(path) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-f", "f32le", "-acodec", "pcm_f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

/** The browser's voiceover against ffmpeg's: length, level, and how alike (best lag). */
function audioParity(ours, theirs) {
  const a = monoSamples(ours), b = monoSamples(theirs);
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  let best = { lag: 0, corr: -1 };
  for (let lag = -2048; lag <= 2048; lag += 1) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = Math.max(0, -lag); i < Math.min(a.length, b.length - lag); i += 3) {
      xy += a[i] * b[i + lag];
      xx += a[i] * a[i];
      yy += b[i + lag] * b[i + lag];
    }
    const corr = xy / Math.sqrt(xx * yy);
    if (corr > best.corr) best = { lag, corr };
  }
  return { lengthDiff: a.length - b.length, levelDb: 20 * Math.log10(rms(a) / rms(b)), ...best };
}

const server = await createServer({
  root: here, configFile: false, logLevel: "warn", server: { port: 0 }, plugins: [fixtureFiles],
  resolve: { alias: { "@": resolve(here, "..", "..") } },
});
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await chromium.launch({ executablePath: opt.chrome, headless: !opt.headed });
let failed = false;
const report = (checks) => {
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
    failed ||= !ok;
  }
};
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("  browser:", m.text()));
  await page.goto(base);
  await page.waitForFunction(() => document.title === "ready", null, { timeout: 60_000 });

  for (const [name, j] of Object.entries(jobs)) {
    const b = await page.evaluate((n) => window.runBuild(n), name);
    const diffs = jsonDiffs(JSON.parse(readFileSync(join(dir, `${name}-plan.json`), "utf8")), JSON.parse(readFileSync(j.plan, "utf8")));
    const v = voiceParity(name, j);
    console.log(`\nbuilt ${name} in the browser: ${b.seconds.toFixed(2)} s of video, in ${(b.ms / 1000).toFixed(2)} s; ` +
      `voice max diff ${v.maxDiff} outside stretched beats${v.gainStep ? " (after a 0.1 dB gain step: the loudness rounded the other way)" : ""}` + (v.levels.length ? `, stretched beats ${v.levels.map((l) => l.toFixed(2)).join(", ")} dB` : ""));
    if (diffs.length) console.log(`  first differences: ${diffs.slice(0, 5).join("; ")}`);
    report({
      [`${name}: plan.json as the frozen one`]: diffs.length === 0,
      [`${name}: voice.wav as long as ffmpeg's`]: v.sameLength,
      [`${name}: voice samples as ffmpeg's (within 2)`]: v.maxDiff <= 2,
      [`${name}: stretched beats at ffmpeg's level (0.5 dB)`]: v.levels.every((l) => Math.abs(l) < 0.5) && (name !== "stretched" || v.levels.length > 0),
    });
  }

  const plan = JSON.parse(readFileSync(join(dir, "flat-plan.json"), "utf8"));
  for (const mode of opt.modes.split(",")) {
    ranges.length = 0;
    const r = await page.evaluate((m) => window.runE2E(m), mode);
    const c = compareRender(join(dir, `${mode}.mp4`), reference);
    const sourceRanges = ranges.filter(([p]) => p === "/files/source.mp4");
    console.log(`\n${mode}: ${c.width}x${c.height} ${c.codec} (${r.encoder.hardwareAcceleration}), ${c.frames} frames, ` +
      `${(r.bytes / 1e6).toFixed(1)} MB, ${(r.ms / 1000).toFixed(1)} s (estimated ${(r.estimatedMs / 1000).toFixed(1)} s), ` +
      `peak JS heap ${r.peakHeapMB.toFixed(0)} MB, ${sourceRanges.length} range reads of the source`);
    console.log(`  audio offset ${c.audio_offset} samples, relative error ${c.audio_rel_error.toExponential(2)}; ` +
      `reference has ${c.ref_frames} frames`);
    report({
      "exact frame count": c.frames === plan.total_frames && r.frames === plan.total_frames && c.ref_frames === plan.total_frames,
      "every frame encoded": r.encoded === plan.total_frames,
      "same frames as the reference render, the held last frame too": c.same,
      "voice lined up (within 1 sample)": Math.abs(c.audio_offset) <= 1,
      "voice matches (AAC noise only)": c.audio_rel_error < 0.01,
      "source read in ranges": sourceRanges.length > 0,
    });
    if (!c.same) console.log(`  first different frame: ${c.first_mismatch}`);
  }

  // the download path: private storage, then a normal download; and a stopped render leaves nothing behind
  const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.runSave())]);
  await download.saveAs(join(dir, "saved.mp4"));
  const saved = compareRender(join(dir, "saved.mp4"), reference);
  const stop = await page.evaluate(() => window.runSave(400));
  console.log(`\nsaving (private storage + download): ${saved.width}x${saved.height}, ${saved.frames} frames`);
  report({
    "download: same frames as the reference render": saved.same && saved.frames === plan.total_frames,
    "stopped render: nothing left behind": stop.stopped && stop.leftovers.length === 0,
  });

  // 4. the approved job: produced in the browser through the produce routes, then built and rendered
  const p = await page.evaluate(() => window.runProduce());
  const ours = mocks.requests.splice(0);
  const bodies = (rs, s) => rs.filter((r) => r.service === s).map((r) => JSON.stringify(r.body)).sort();
  const inputsDiffs = jsonDiffs(JSON.parse(readFileSync(join(runFolder, "inputs.json"), "utf8")), vtProduced.inputs);
  const claudeCalls = ours.filter((r) => r.service === "claude").length;
  console.log(`\nproduced "de" in the browser in ${(p.ms / 1000).toFixed(1)} s: ${p.stages.join(" -> ")}; ` +
    `${claudeCalls} Claude calls, ${ours.length - claudeCalls} ElevenLabs calls; ${vtProduced.flags.length} flags left`);
  if (inputsDiffs.length) console.log(`  first differences: ${inputsDiffs.slice(0, 5).join("; ")}`);
  // the reference: ffmpeg's voice track and render of the frozen plan, from the clips the produce routes stored
  const pj = referenceOf(join(dir, "produced-reference"), vtProduced.plan, join(runFolder, "tts"), vtProduced.analysis.base_lufs);
  const pb = await page.evaluate(() => window.runBuild("produced"));
  const planDiffs = jsonDiffs(JSON.parse(readFileSync(join(dir, "produced-plan.json"), "utf8")), vtProduced.plan);
  const pv = voiceParity("produced", pj);
  const pplan = JSON.parse(readFileSync(join(dir, "produced-plan.json"), "utf8"));
  const pr = await page.evaluate(() => window.runE2E("preview", "produced"));
  const pc = compareRender(join(dir, "produced-preview.mp4"), renderReference(vtProduced.plan, sourcePath, pj.voice, join(dir, "produced-reference.mp4")));
  const stretched = pplan.beats.some((b) => b.tempo !== 1);
  console.log(`  built: ${pb.seconds.toFixed(2)} s; voice max diff ${pv.maxDiff} outside stretched beats` +
    (pv.levels.length ? `, stretched beats ${pv.levels.map((l) => l.toFixed(2)).join(", ")} dB` : "") +
    `; preview ${pc.frames} frames, audio offset ${pc.audio_offset}, relative error ${pc.audio_rel_error.toExponential(2)}`);
  const claudeDiffs = jsonDiffs(ours.filter((r) => r.service === "claude").map((r) => r.body),
                                vtRequests.filter((r) => r.service === "claude").map((r) => r.body));
  if (claudeDiffs.length) console.log(`  Claude requests differ: ${claudeDiffs.slice(0, 3).join("; ")}`);
  // with a stretched beat (WSOLA here, atempo in ffmpeg) the voice was compared beat by beat when it was built
  if (stretched) console.log("  (a beat is stretched: the render's voice isn't compared sample for sample with the reference's)");
  report({
    "produced: the same Claude requests as the frozen ones, in order": claudeDiffs.length === 0 && claudeCalls > 0,
    "produced: the same ElevenLabs requests as the frozen ones": JSON.stringify(bodies(ours, "eleven")) === JSON.stringify(bodies(vtRequests, "eleven")),
    "produced: Claude rewrote beats": ours.some((r) => r.service === "claude" && r.body.messages[0].content.startsWith("Here is the original")),
    "produced: inputs.json as the frozen one": inputsDiffs.length === 0,
    "produced: plan.json as the frozen one": planDiffs.length === 0,
    "produced: voice.wav as long as ffmpeg's": pv.sameLength,
    "produced: voice samples as ffmpeg's (within 2)": pv.maxDiff <= 2,
    "produced: stretched beats at ffmpeg's level (0.5 dB)": pv.levels.every((l) => Math.abs(l) < 0.5),
    "produced: preview has every frame, the same as the reference render": pc.same && pc.frames === pplan.total_frames && pr.encoded === pplan.total_frames,
    "produced: voice lined up (within 1 sample)": stretched || Math.abs(pc.audio_offset) <= 1,
    "produced: voice matches (AAC noise only)": stretched || pc.audio_rel_error < 0.01,
  });

  // 5. a new video: checked, measured, uploaded, prepared, edited and timed again, produced, built and rendered
  console.log("\nnew videos in the browser (no worker):");
  const checks = await page.evaluate((names) => window.runChecks(names), CHECKED);
  const refused = { hlg: /HDR \(HLG\)/, pq: /HDR \(PQ\)/, silent: /no sound/, mpeg4: /can't decode this video's picture/,
                    ac3: /can't decode this video's sound/, tiny: /too short/ };
  for (const [n, c] of Object.entries(checks)) console.log(`  ${n}: ${c.ok ? `ok, ${c.summary}${c.notes.length ? ` (${c.notes.join(" ")})` : ""}` : c.reason}`);
  report(Object.fromEntries(CHECKED.map((n) => [`checks: ${n} ${refused[n] ? "refused, saying why" : "accepted"}`,
    refused[n] ? !checks[n].ok && refused[n].test(checks[n].reason) : checks[n].ok])));
  // a video that reached storage without the checks (a project from an older version) is refused when it's measured
  const measuredHdr = await page.evaluate((x) => window.runMeasure(x).then(() => "measured", (e) => e.message), "hlg");
  report({ "measuring an HDR video refuses it, saying why": refused.hlg.test(measuredHdr) });
  for (const n of MEASURED) {
    const r = await page.evaluate((x) => window.runMeasure(x), n);
    const ours = JSON.parse(readFileSync(join(dir, `measure-${n}.json`), "utf8"));
    const ff = media(files[`videos/${n}.mp4`]);
    const ffAudio = voiceover(files[`videos/${n}.mp4`], join(dir, `ffmpeg-${n}.m4a`));
    const a = audioParity(join(dir, `measure-${n}-${r.audio}`), ffAudio);
    console.log(`  measured ${n} in ${(r.ms / 1000).toFixed(2)} s (sound ${(r.phases.sound / 1000).toFixed(2)} s, cuts ${(r.phases.cuts / 1000).toFixed(2)} s, ${ours.frames} frames): ` +
      `cuts ${JSON.stringify(ours.cuts)}${JSON.stringify(ours.cuts) === JSON.stringify(ff.cuts) ? "" : ` vs ffmpeg ${JSON.stringify(ff.cuts)}`}, ` +
      `${ours.base_lufs} LUFS; voiceover ${r.audio}: ${a.lengthDiff} samples longer, ${a.levelDb.toFixed(2)} dB, correlation ${a.corr.toFixed(3)} at lag ${a.lag}`);
    report({
      [`measured ${n}: length, frame rate and size as ffprobe's`]: ours.dur === ff.dur && ours.fps === ff.fps && ours.width === ff.width && ours.height === ff.height,
      [`measured ${n}: the cuts ffmpeg's scene filter finds`]: JSON.stringify(ours.cuts) === JSON.stringify(ff.cuts),
      [`measured ${n}: the loudness ffmpeg's ebur128 measures`]: ours.base_lufs === ff.base_lufs,
      // Chrome's AAC encoder leaves its padding at the end (up to two AAC frames longer); STT and alignment don't mind
      [`measured ${n}: the voiceover as ffmpeg's (mono AAC, lined up, as long within two AAC frames, level within 0.5 dB)`]:
        a.lengthDiff >= 0 && a.lengthDiff <= 2048 && a.lag === 0 && Math.abs(a.levelDb) < 0.5 && a.corr > 0.95,
    });
  }

  for (const n of Object.keys(BENCH)) {
    const r = await page.evaluate((x) => window.runMeasure(x), n);
    console.log(`  bench: measured ${n} (2 minutes, ${BENCH[n]}) in ${(r.ms / 1000).toFixed(1)} s: sound ${(r.phases.sound / 1000).toFixed(1)} s, cuts ${(r.phases.cuts / 1000).toFixed(1)} s`);
  }

  // what the Python pipeline made of the same video against the fakes (the old worker's way), with the same names
  // for reference (frozen)
  const vtPrepared = FROZEN.upload.prepared;
  const vtPrepareRequests = vtPrepared.requests;
  mocks.clear();
  const pb2 = await prepared();
  pb2.submit("e2e-browser");
  const up = await page.evaluate((o) => window.runPrepare(o), { ...UPLOAD, status: "preparing", withFile: true, upload: true });
  const ourPrepareRequests = mocks.requests.splice(0);
  const analysisPath = join(store, "u", UPLOAD.userId, UPLOAD.jobId, "analysis.json");
  const ourAnalysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  const prepDiffs = jsonDiffs(ourAnalysis, vtPrepared.analysis);
  console.log(`  prepared the upload in ${(up.ms / 1000).toFixed(1)} s: ${up.stages.join(" -> ")}; ${ourPrepareRequests.length} paid calls ` +
    `(the Python pipeline: ${vtPrepareRequests.length}); names fixed: ${pb2.row.names_fixed.join("; ")}`);
  if (prepDiffs.length) console.log(`  first differences: ${prepDiffs.slice(0, 5).join("; ")}`);
  report({
    "upload: ready for review": up.status === "needs_review" && pb2.row.status === "needs_review",
    "upload: analysis.json as the frozen one": prepDiffs.length === 0,
    "upload: transcript, names and warnings as the frozen ones": pb2.row.script === vtPrepared.script &&
      JSON.stringify(pb2.row.names_fixed) === JSON.stringify(vtPrepared.names_fixed) && JSON.stringify(pb2.row.warnings) === JSON.stringify(vtPrepared.warnings),
    "upload: the same Claude name check as the frozen one": ourPrepareRequests.some((q) => q.service === "claude") &&
      jsonDiffs(ourPrepareRequests.filter((q) => q.service === "claude").map((q) => q.body),
                vtPrepareRequests.filter((q) => q.service === "claude").map((q) => q.body)).length === 0,
    "upload: the same speech-to-text and (last) forced alignment as the frozen ones": ["/v1/speech-to-text", "/v1/forced-alignment"].every((path) =>
      jsonDiffs(ourPrepareRequests.filter((q) => q.path === path).map((q) => q.body), vtPrepareRequests.filter((q) => q.path === path).map((q) => q.body).slice(-1)).length === 0),
  });

  // the person fixes a spelling; the edited transcript is timed again, reading the upload back from storage
  const edited = pb2.row.script.replace("lights.", "lights!");
  const vtAligned = FROZEN.upload.aligned;
  mocks.clear();
  for (const f of ["media.json", "audio.m4a", "audio.wav"]) rmSync(join(store, "u", UPLOAD.userId, UPLOAD.jobId, "prep", f), { force: true });
  pb2.approve(edited, "e2e-browser");
  const al = await page.evaluate((o) => window.runPrepare(o), { ...UPLOAD, status: "aligning", withFile: false, upload: false });
  const alignDiffs = jsonDiffs(JSON.parse(readFileSync(analysisPath, "utf8")), vtAligned.analysis);
  console.log(`  timed the edited transcript in ${(al.ms / 1000).toFixed(1)} s: ${al.stages.join(" -> ")}`);
  if (alignDiffs.length) console.log(`  first differences: ${alignDiffs.slice(0, 5).join("; ")}`);
  report({
    "edited: translating next, as the old worker's align decided": edited === FROZEN.upload.edited && al.status === "producing" &&
      pb2.row.status === "producing" && vtAligned.ok,
    "edited: analysis.json as the old worker's align": alignDiffs.length === 0,
    // the measures come from the analysis already there (as for a project an older worker analyzed)
    "edited: the voiceover read back from storage": al.stages.includes("measuring sound") && !al.stages.includes("measuring cuts"),
  });

  // and produced, built and rendered, against the Python pipeline's produce of its own preparation (frozen) and
  // ffmpeg's render of that plan
  const vtUp = FROZEN.upload.produced;
  mocks.clear();
  const pu = await page.evaluate((id) => window.runProduce(id), UPLOAD.jobId);
  const upInputs = jsonDiffs(JSON.parse(readFileSync(join(uploadRunFolder, "inputs.json"), "utf8")), vtUp.inputs);
  await page.evaluate(() => window.runBuild("uploaded"));
  const upPlan = jsonDiffs(JSON.parse(readFileSync(join(dir, "uploaded-plan.json"), "utf8")), vtUp.plan);
  const upRef = referenceOf(join(dir, "uploaded-reference"), vtUp.plan, join(uploadRunFolder, "tts"), vtAligned.analysis.base_lufs);
  const upVoice = voiceParity("uploaded", upRef);
  const uplan = JSON.parse(readFileSync(join(dir, "uploaded-plan.json"), "utf8"));
  const ur = await page.evaluate((src) => window.runE2E("preview", "uploaded", src), `/files/videos/${UPLOAD.video}.mp4`);
  const uc = compareRender(join(dir, "uploaded-preview.mp4"),
    renderReference(vtUp.plan, files[`videos/${UPLOAD.video}.mp4`], upRef.voice, join(dir, "uploaded-reference.mp4")));
  const ustretched = uplan.beats.some((b) => b.tempo !== 1);
  console.log(`  produced "de" in ${(pu.ms / 1000).toFixed(1)} s: ${pu.stages.join(" -> ")}; preview ${uc.frames} frames, ` +
    `audio offset ${uc.audio_offset}, relative error ${uc.audio_rel_error.toExponential(2)}`);
  if (upInputs.length) console.log(`  first differences: ${upInputs.slice(0, 5).join("; ")}`);
  report({
    "upload: inputs.json as the frozen one": upInputs.length === 0,
    "upload: plan.json as the frozen one": upPlan.length === 0,
    "upload: voice.wav as ffmpeg's": upVoice.sameLength && upVoice.maxDiff <= 2 && upVoice.levels.every((l) => Math.abs(l) < 0.5),
    "upload: preview has every frame, the same as the reference render": uc.same && uc.frames === uplan.total_frames && ur.encoded === uplan.total_frames,
    "upload: voice lined up and matching": ustretched || (Math.abs(uc.audio_offset) <= 1 && uc.audio_rel_error < 0.01),
  });
} finally {
  await mocks.close();
  await browser.close();
  await server.close();
  if (!opt.keep && !failed) rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "\nFAILED" : "\nall good");
process.exit(failed ? 1 : 0);
