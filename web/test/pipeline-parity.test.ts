// The timing plan and the voice track built in TypeScript (lib/pipeline) against scripts/vt.py on the same
// inputs: synthetic jobs made by test/pipeline_fixture.py (no API calls) that hit the solver's corners. The
// clips are decoded with ffmpeg here (in the browser, decodeAudioData gives the same samples: test/e2e checks).
//
//   plan.json: integers (frames, ids, counts) exactly; floats within 1e-9; flags and the report word for word.
//   voice.wav: same length; outside the stretched beats every sample within 2 (the MP3 decoders differ in the
//   last bit); the stretched beats (WSOLA here, atempo in vt.py) within 0.5 dB in level. See "Voice track
//   parity" in docs/web-setup.md.
//
// Needs ffmpeg and uv; skipped otherwise.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWav } from "../lib/render/wav";
import { buildLanguage, clipDuration } from "../lib/pipeline/build";
import { metaFile, parseClipMeta, parseInputs } from "../lib/pipeline/inputs";
import { writeReport } from "../lib/pipeline/plan";

const FIXTURE = resolve(__dirname, "pipeline_fixture.py");
const has = (cmd: string, arg = "-version") => {
  try {
    execFileSync(cmd, [arg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ready = has("ffmpeg") && has("uv", "--version");
const py = (...args: string[]) =>
  execFileSync("uv", ["run", "-q", "--no-project", "--with", "requests", "python", FIXTURE, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

export function decodeWithFfmpeg(file: string): Float32Array {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

type Case = {
  name: string; kind: string; inputs: string; tts: string; plan: string; report: string; voice: string; job_name: string;
  durations: Record<string, number>; tempos: number[];
};

/** Deep equality: numbers that are integers in both must be equal; other numbers within tol. */
function compare(a: unknown, b: unknown, path: string, tol: number, out: string[]) {
  if (typeof a === "number" && typeof b === "number") {
    const ok = Number.isInteger(a) && Number.isInteger(b) ? a === b : Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
    if (!ok) out.push(`${path}: ${a} vs ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    else a.forEach((x, i) => compare(x, b[i], `${path}[${i}]`, tol, out));
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path}: keys ${ka} vs ${kb}`);
    for (const k of kb) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, tol, out);
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

describe.skipIf(!ready)("lib/pipeline against vt.py", () => {
  let dir = "";
  let cases: Case[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vt-pipeline-"));
    cases = JSON.parse(py("cases", dir, "--count", "27", "--seed", "7"));
  }, 600_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("covers the solver's corners", () => {
    const plans = cases.map((c) => JSON.parse(readFileSync(c.plan, "utf8")));
    expect(plans.some((p) => p.flags.some((f: { cut: number | null; beat: number | null }) => f.cut !== null && f.beat !== null))).toBe(true); // conflicts
    expect(plans.some((p) => p.flags.some((f: { beat: number | null }) => f.beat === null))).toBe(true); // dropped markers
    expect(plans.some((p) => p.segments.some((s: { trimmed: number }) => s.trimmed > 0.02))).toBe(true);
    expect(plans.some((p) => p.beats.some((b: { tempo: number }) => b.tempo > 1))).toBe(true);
    expect(plans.some((p) => p.beats.some((b: { tempo: number }) => b.tempo < 1))).toBe(true);
    expect(plans.some((p) => p.segments.some((s: { speed: number }) => Math.abs(s.speed - 1.1) < 1e-12))).toBe(true);
    expect(plans.some((p) => p.segments.some((s: { speed: number }) => Math.abs(s.speed - 0.9) < 1e-12))).toBe(true);
  });

  it("builds the same plan.json, flags and report", () => {
    for (const c of cases) {
      const inputs = parseInputs(JSON.parse(readFileSync(c.inputs, "utf8")));
      const clips = inputs.clips.map((k) => {
        const samples = decodeWithFfmpeg(join(c.tts, k.file));
        // the clip's length as vt.py had it (ffprobe)
        expect(clipDuration(samples.length), `${c.name} ${k.file}`).toBe(c.durations[k.file]);
        return { meta: parseClipMeta(JSON.parse(readFileSync(join(c.tts, metaFile(k.file)), "utf8")), k.file), samples, sampleRate: 44100 };
      });
      const built = buildLanguage(inputs, clips);
      const want = JSON.parse(readFileSync(c.plan, "utf8"));
      const diffs: string[] = [];
      compare(JSON.parse(JSON.stringify(built.portable)), want, c.name, 1e-9, diffs);
      expect(diffs, `${c.name} (${c.kind})`).toEqual([]);
      expect(writeReport(c.job_name, built.plan), c.name).toBe(readFileSync(c.report, "utf8"));
    }
  });

  it("builds the same voice.wav", () => {
    const rows: string[] = [];
    for (const c of cases) {
      const inputs = parseInputs(JSON.parse(readFileSync(c.inputs, "utf8")));
      const clips = inputs.clips.map((k) => ({
        meta: parseClipMeta(JSON.parse(readFileSync(join(c.tts, metaFile(k.file)), "utf8")), k.file),
        samples: decodeWithFfmpeg(join(c.tts, k.file)), sampleRate: 44100,
      }));
      const built = buildLanguage(inputs, clips);
      const got = parseWav(built.voice);
      const want = parseWav(readFileSync(c.voice).buffer as ArrayBuffer);
      expect(got.channels).toBe(2);
      expect(got.sampleRate).toBe(44100);
      expect(got.frames, `${c.name} length`).toBe(want.frames);
      // the stretched beats' stretches of the track (atempo vs WSOLA: compared by level, not sample by sample)
      const stretchedSpans = built.plan.beats.filter((b) => b.tempo !== 1).map((b) => {
        const at = Math.round(b.offset * 44100) + 219; // the limiter's delay
        return [at - 2048, at + Math.round(b.dur * 44100) + 2048];
      });
      const inStretch = (k: number) => stretchedSpans.some(([a, z]) => k >= a && k < z);
      // With a stretched beat the loudness measured before the gain differs a little, and once in a while it
      // rounds (to 0.1 LU, as vt.lufs reads it) the other way: then the whole track is 0.1 dB louder or quieter.
      let xy = 0, yy = 0;
      for (let k = 0; k < want.frames; k++) {
        if (inStretch(k)) continue;
        xy += got.data[2 * k] * want.data[2 * k];
        yy += want.data[2 * k] ** 2;
      }
      const ratio = yy ? xy / yy : 1;
      const step = stretchedSpans.length ? [1, 10 ** (0.1 / 20), 10 ** (-0.1 / 20)] : [1];
      const scale = step.reduce((a, b) => (Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a));
      expect(Math.abs(ratio - scale), `${c.name}: gain ratio ${ratio}`).toBeLessThan(2e-4);
      let maxDiff = 0, err = 0, ref = 0;
      for (let k = 0; k < want.frames; k++) {
        if (inStretch(k)) continue;
        const d = got.data[2 * k] - Math.round(want.data[2 * k] * scale);
        maxDiff = Math.max(maxDiff, Math.abs(d));
        err += d * d;
        ref += want.data[2 * k] ** 2;
      }
      const rel = err / Math.max(1, ref);
      const levels = stretchedSpans.map(([a, z]) => {
        let eg = 0, ew = 0;
        for (let k = Math.max(0, a); k < Math.min(want.frames, z); k++) {
          eg += got.data[2 * k] ** 2;
          ew += want.data[2 * k] ** 2;
        }
        return 10 * Math.log10(eg / ew);
      });
      rows.push(`${c.name} ${c.kind}: unstretched max diff ${maxDiff}, rel error ${rel.toExponential(2)}` +
        (scale !== 1 ? ` (gain ${scale > 1 ? "+" : "-"}0.1 dB: the loudness rounded the other way)` : "") +
        (levels.length ? `; stretched beats level ${levels.map((l) => l.toFixed(2)).join(", ")} dB` : ""));
      expect(maxDiff, `${c.name}: ${rows.at(-1)}`).toBeLessThanOrEqual(2); // the MP3 decoders differ in the last bit
      expect(rel).toBeLessThan(1e-4);
      for (const l of levels) expect(Math.abs(l), `${c.name}: ${rows.at(-1)}`).toBeLessThan(0.5);
    }
    console.log(rows.join("\n"));
  });
});
