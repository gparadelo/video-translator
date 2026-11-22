// End-to-end check in a real browser (Google Chrome, headless), no network and no paid APIs:
//   1. makes a fake job with scripts/vt.py (synthetic video with frame numbers drawn in, fake voice clips,
//      a plan) and renders it with the CLI (vt.cmd_render) as the reference,
//   2. renders the same plan in Chrome with lib/render (the source read with range requests),
//   3. checks every output frame shows the same source frame as the reference, and that the voice lines up.
//
//   pnpm e2e [--size 1080x1920] [--rate 30] [--modes preview,original,720p] [--chrome /path/to/chrome] [--headed]
//
// Needs ffmpeg, uv and Chrome (CHROME_PATH or --chrome; defaults to the usual macOS location).

import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const py = (...args) =>
  execFileSync("uv", ["run", "-q", "--no-project", "--with", "requests", "python", join(here, "..", "vt_fixture.py"), ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });

const dir = mkdtempSync(join(tmpdir(), "vt-e2e-"));
console.log(`fixture job in ${dir} (${opt.size}, ${opt.rate} fps)`);
const job = JSON.parse(py("job", dir, "--size", opt.size, "--rate", opt.rate, "--render").trim().split("\n")[0]);
const reference = join(dir, "out", `${dir.split("/").pop()}_xx.mp4`);
const files = { "source.mp4": job.source, "plan.json": job.plan, "voice.wav": job.voice };
const ranges = [];

// Serves the fixture files with HTTP range support (like R2) and takes the rendered files back.
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

const server = await createServer({ root: here, configFile: false, logLevel: "warn", server: { port: 0 }, plugins: [fixtureFiles] });
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await chromium.launch({ executablePath: opt.chrome, headless: !opt.headed });
let failed = false;
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("  browser:", m.text()));
  await page.goto(base);
  await page.waitForFunction(() => document.title === "ready", null, { timeout: 60_000 });
  const plan = JSON.parse(readFileSync(job.plan, "utf8"));
  for (const mode of opt.modes.split(",")) {
    ranges.length = 0;
    const r = await page.evaluate((m) => window.runE2E(m), mode);
    const c = JSON.parse(py("compare", join(dir, `${mode}.mp4`), reference));
    const sourceRanges = ranges.filter(([p]) => p === "/files/source.mp4");
    const checks = {
      "exact frame count": c.frames === plan.total_frames && r.frames === plan.total_frames && c.ref_frames === plan.total_frames,
      "every frame encoded": r.encoded === plan.total_frames,
      "same frames as vt.py, the held last frame too": c.same,
      "voice lined up (within 1 sample)": Math.abs(c.audio_offset) <= 1,
      "voice matches (AAC noise only)": c.audio_rel_error < 0.01,
      "source read in ranges": sourceRanges.length > 0,
    };
    console.log(`\n${mode}: ${c.width}x${c.height} ${c.codec} (${r.encoder.hardwareAcceleration}), ${c.frames} frames, ` +
      `${(r.bytes / 1e6).toFixed(1)} MB, ${(r.ms / 1000).toFixed(1)} s (estimated ${(r.estimatedMs / 1000).toFixed(1)} s), ` +
      `peak JS heap ${r.peakHeapMB.toFixed(0)} MB, ${sourceRanges.length} range reads of the source`);
    console.log(`  audio offset ${c.audio_offset} samples, relative error ${c.audio_rel_error.toExponential(2)}; ` +
      `reference has ${c.ref_frames} frames`);
    for (const [name, ok] of Object.entries(checks)) {
      console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
      failed ||= !ok;
    }
    if (!c.same) console.log(`  first different frame: ${c.first_mismatch}`);
  }

  // the download path: private storage, then a normal download; and a stopped render leaves nothing behind
  const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.runSave())]);
  await download.saveAs(join(dir, "saved.mp4"));
  const saved = JSON.parse(py("compare", join(dir, "saved.mp4"), reference));
  const stop = await page.evaluate(() => window.runSave(400));
  const saveChecks = {
    "download: same frames as vt.py": saved.same && saved.frames === plan.total_frames,
    "stopped render: nothing left behind": stop.stopped && stop.leftovers.length === 0,
  };
  console.log(`
saving (private storage + download): ${saved.width}x${saved.height}, ${saved.frames} frames`);
  for (const [name, ok] of Object.entries(saveChecks)) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
    failed ||= !ok;
  }
} finally {
  await browser.close();
  await server.close();
  if (!opt.keep && !failed) rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "\nFAILED" : "\nall good");
process.exit(failed ? 1 : 0);
