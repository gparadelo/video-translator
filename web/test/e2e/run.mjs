// End-to-end check in a real browser (Google Chrome, headless), no network and no paid APIs:
//   1. makes fake jobs with scripts/vt.py (test/pipeline_fixture.py e2e: a synthetic video with frame numbers
//      drawn in, a synthetic analysis, fake TTS clips) up to the plan inputs the worker uploads, and renders
//      them with the CLI (vt.cmd_render) as the reference,
//   2. in Chrome, builds each job's plan.json and voice.wav from its plan inputs with lib/pipeline (the clips
//      decoded by the browser) and checks them against vt.py's,
//   3. renders the "flat" job (every tempo 1) from what the browser built with lib/render, the source read with
//      range requests, and checks every output frame shows the same source frame as the CLI render, and that
//      the voice lines up. The "stretched" job (a beat's tempo isn't 1: WSOLA here, atempo in vt.py) is checked
//      beat by beat in step 2.
//
//   pnpm e2e [--size 1080x1920] [--rate 30] [--modes preview,original,720p] [--chrome /path/to/chrome] [--headed]
//
// Needs ffmpeg, uv and Chrome (CHROME_PATH or --chrome; defaults to the usual macOS location).

import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = resolve(import.meta.dirname);
const { values: opt } = parseArgs({
  options: {
    size: { type: "string", default: "1080x1920" },
    rate: { type: "string", default: "30" },
    modes: { type: "string", default: "preview,original,720p" },
    chrome: { type: "string", default: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    headed: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});

const py = (script, ...args) =>
  execFileSync("uv", ["run", "-q", "--no-project", "--with", "requests", "python", join(here, "..", script), ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });

const dir = mkdtempSync(join(tmpdir(), "vt-e2e-"));
console.log(`fixture jobs in ${dir} (${opt.size}, ${opt.rate} fps)`);
const jobs = JSON.parse(py("pipeline_fixture.py", "e2e", dir, "--size", opt.size, "--rate", opt.rate).trim());
const reference = jobs.flat.reference;
const files = { "source.mp4": jobs.flat.source };
for (const [name, j] of Object.entries(jobs)) {
  files[`${name}/inputs.json`] = j.inputs;
  const inputs = JSON.parse(readFileSync(j.inputs, "utf8"));
  for (const c of inputs.clips) {
    files[`${name}/tts/${c.file}`] = join(j.tts, c.file);
    files[`${name}/tts/${c.file.replace(/\.mp3$/, ".json")}`] = join(j.tts, c.file.replace(/\.mp3$/, ".json"));
  }
}
const ranges = [];

// Serves the fixture files with HTTP range support (like R2) and takes the browser's files back.
const fixtureFiles = {
  name: "fixture-files",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/favicon.ico") return void (res.statusCode = 204, res.end());
      if (url.pathname.startsWith("/files/")) {
        const path = files[url.pathname.slice(7)];
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

/** The browser's voice.wav against vt.py's: outside stretched beats sample by sample, stretched beats by level. */
function voiceParity(name, j) {
  const got = wavSamples(join(dir, `${name}-voice.wav`)), want = wavSamples(join(dirname(j.inputs), "voice.wav"));
  const plan = JSON.parse(readFileSync(join(dir, `${name}-plan.json`), "utf8"));
  const spans = plan.beats.filter((b) => b.tempo !== 1).map((b) => {
    const at = Math.round(b.offset * 44100) + 219;
    return [at - 2048, at + Math.round(b.dur * 44100) + 2048];
  });
  // a stretched beat changes the measured loudness a little; when it rounds (to 0.1 LU, like vt.lufs) the other
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
      [`${name}: plan.json as vt.py's`]: diffs.length === 0,
      [`${name}: voice.wav as long as vt.py's`]: v.sameLength,
      [`${name}: voice samples as vt.py's (within 2)`]: v.maxDiff <= 2,
      [`${name}: stretched beats at vt.py's level (0.5 dB)`]: v.levels.every((l) => Math.abs(l) < 0.5) && (name !== "stretched" || v.levels.length > 0),
    });
  }

  const plan = JSON.parse(readFileSync(join(dir, "flat-plan.json"), "utf8"));
  for (const mode of opt.modes.split(",")) {
    ranges.length = 0;
    const r = await page.evaluate((m) => window.runE2E(m), mode);
    const c = JSON.parse(py("vt_fixture.py", "compare", join(dir, `${mode}.mp4`), reference));
    const sourceRanges = ranges.filter(([p]) => p === "/files/source.mp4");
    console.log(`\n${mode}: ${c.width}x${c.height} ${c.codec} (${r.encoder.hardwareAcceleration}), ${c.frames} frames, ` +
      `${(r.bytes / 1e6).toFixed(1)} MB, ${(r.ms / 1000).toFixed(1)} s (estimated ${(r.estimatedMs / 1000).toFixed(1)} s), ` +
      `peak JS heap ${r.peakHeapMB.toFixed(0)} MB, ${sourceRanges.length} range reads of the source`);
    console.log(`  audio offset ${c.audio_offset} samples, relative error ${c.audio_rel_error.toExponential(2)}; ` +
      `reference has ${c.ref_frames} frames`);
    report({
      "exact frame count": c.frames === plan.total_frames && r.frames === plan.total_frames && c.ref_frames === plan.total_frames,
      "every frame encoded": r.encoded === plan.total_frames,
      "same frames as vt.py, the held last frame too": c.same,
      "voice lined up (within 1 sample)": Math.abs(c.audio_offset) <= 1,
      "voice matches (AAC noise only)": c.audio_rel_error < 0.01,
      "source read in ranges": sourceRanges.length > 0,
    });
    if (!c.same) console.log(`  first different frame: ${c.first_mismatch}`);
  }

  // the download path: private storage, then a normal download; and a stopped render leaves nothing behind
  const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.runSave())]);
  await download.saveAs(join(dir, "saved.mp4"));
  const saved = JSON.parse(py("vt_fixture.py", "compare", join(dir, "saved.mp4"), reference));
  const stop = await page.evaluate(() => window.runSave(400));
  console.log(`\nsaving (private storage + download): ${saved.width}x${saved.height}, ${saved.frames} frames`);
  report({
    "download: same frames as vt.py": saved.same && saved.frames === plan.total_frames,
    "stopped render: nothing left behind": stop.stopped && stop.leftovers.length === 0,
  });
} finally {
  await browser.close();
  await server.close();
  if (!opt.keep && !failed) rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "\nFAILED" : "\nall good");
process.exit(failed ? 1 : 0);
