// The voice track's signal processing (lib/pipeline) against ffmpeg, which vt.py uses: the loudness meter
// against `ebur128`, the time stretch against `atempo`, the limiter against `alimiter`. Synthetic signals only.
// Needs ffmpeg; skipped otherwise.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { integratedLoudness, lufsOneDecimal } from "../lib/pipeline/loudness";
import { limit, limiterDelay } from "../lib/pipeline/limiter";
import { encodeWav } from "../lib/pipeline/voice";
import { stretch, stretchedLength } from "../lib/pipeline/wsola";

const SR = 44100;
const ready = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const dir = mkdtempSync(join(tmpdir(), "vt-dsp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ffmpegRaw(input: ArrayBufferView, inFmt: "f32le" | "f64le", filter: string): Buffer {
  const i = join(dir, "in.raw"), o = join(dir, "out.raw");
  writeFileSync(i, Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", inFmt, "-ar", String(SR), "-ac", "1", "-i", i, "-af", filter, "-f", inFmt, o]);
  return readFileSync(o);
}
const f32 = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const f64 = (b: Buffer) => new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** A deterministic noise source. */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

const signals: Record<string, (t: number, r: () => number) => number> = {
  "tone 1 kHz -20 dBFS": (t) => 0.1 * Math.sin(2 * Math.PI * 1000 * t),
  "low tone 60 Hz": (t) => 0.3 * Math.sin(2 * Math.PI * 60 * t),
  "high tone 9 kHz": (t) => 0.2 * Math.sin(2 * Math.PI * 9000 * t),
  "two levels (relative gate)": (t) => (t < 2 ? 0.3 : 0.01) * Math.sin(2 * Math.PI * 440 * t),
  "bursts and silence": (t) => (Math.floor(t * 3) % 2 ? 0.2 : 0) * Math.sin(2 * Math.PI * 300 * t),
  "quiet, near the gate": (t) => 0.0004 * Math.sin(2 * Math.PI * 1000 * t),
  noise: (_t, r) => 0.2 * r(),
  "speech-like (noise bursts with pauses)": (t, r) => (Math.sin(2 * Math.PI * 4 * t) > 0.2 ? 0.3 : 0.002) * r(),
};

describe.skipIf(!ready)("loudness meter vs ffmpeg ebur128", () => {
  for (const [name, fn] of Object.entries(signals)) {
    it(name, () => {
      const r = noise(7);
      const pcm = Int16Array.from({ length: Math.round(5.37 * SR) }, (_, i) => Math.round(fn(i / SR, r) * 32767));
      const file = join(dir, "lufs.wav");
      writeFileSync(file, Buffer.from(encodeWav(pcm, SR, 1)));
      const out = execFileSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af",
        "ebur128=metadata=1,ametadata=print:key=lavfi.r128.I:file=-", "-f", "null", "-"], { encoding: "utf8" });
      const want = Number([...out.matchAll(/lavfi\.r128\.I=(-?[\d.]+)/g)].at(-1)![1]);
      const x = Float64Array.from(pcm, (v) => v / 32768);
      expect(Math.abs(integratedLoudness(x, SR) - want)).toBeLessThan(0.002); // ffmpeg prints 3 decimals
      expect(Math.abs(lufsOneDecimal(x, SR) - want)).toBeLessThanOrEqual(0.05 + 1e-9);
    });
  }
  it("silence is -70, as ffmpeg reports it", () => {
    expect(integratedLoudness(new Float64Array(SR * 2), SR)).toBe(-70);
  });
});

/** Residual after the best sine fit at `f` in each 1024-sample block, relative to the signal (dB). */
function purity(y: Float32Array, f: number, from: number, to: number) {
  let res = 0, sig = 0;
  for (let s = from; s + 1024 <= to; s += 1024) {
    let c = 0, si = 0;
    for (let i = 0; i < 1024; i++) {
      c += y[s + i] * Math.cos((2 * Math.PI * f * (s + i)) / SR);
      si += y[s + i] * Math.sin((2 * Math.PI * f * (s + i)) / SR);
    }
    c *= 2 / 1024;
    si *= 2 / 1024;
    for (let i = 0; i < 1024; i++) {
      const fit = c * Math.cos((2 * Math.PI * f * (s + i)) / SR) + si * Math.sin((2 * Math.PI * f * (s + i)) / SR);
      res += (y[s + i] - fit) ** 2;
      sig += y[s + i] ** 2;
    }
  }
  return 10 * Math.log10(res / sig);
}

/** Energy in octave bands (dB), for comparing the spectrum of noise. */
function bands(y: Float32Array, from: number, to: number) {
  const N = 4096;
  const out = new Array(7).fill(0);
  for (let s = from; s + N <= to; s += N) {
    for (let b = 0; b < 7; b++) {
      // a few probe frequencies per octave band, from 125 Hz up
      for (const k of [1, 1.26, 1.59]) {
        const f = 125 * 2 ** b * k;
        let re = 0, im = 0;
        for (let i = 0; i < N; i++) {
          const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
          re += w * y[s + i] * Math.cos((2 * Math.PI * f * i) / SR);
          im += w * y[s + i] * Math.sin((2 * Math.PI * f * i) / SR);
        }
        out[b] += re * re + im * im;
      }
    }
  }
  return out.map((e) => 10 * Math.log10(e));
}

describe.skipIf(!ready)("time stretch (WSOLA) vs ffmpeg atempo", () => {
  for (const tempo of [0.96, 0.98, 1.005, 1.03, 1.07]) {
    it(`tempo ${tempo}: exact length, words stay in place, a clean tone`, () => {
      for (const f of [150, 440, 1000, 3000]) {
        const x = Float32Array.from({ length: SR * 3 }, (_, i) => (i > 20000 && i < 100000 ? 0.3 : 0) * Math.sin((2 * Math.PI * f * i) / SR));
        const y = stretch(x, tempo);
        const a = f32(ffmpegRaw(x, "f32le", `atempo=${tempo}`));
        expect(y.length).toBe(stretchedLength(x.length, tempo));
        // the burst starts and ends where the tempo puts it (atempo smears it ~20 ms early)
        const onset = y.findIndex((v) => Math.abs(v) > 0.05);
        const end = y.length - [...y].reverse().findIndex((v) => Math.abs(v) > 0.05);
        expect(Math.abs(onset - 20000 / tempo) / SR).toBeLessThan(0.003);
        expect(Math.abs(end - 100000 / tempo) / SR).toBeLessThan(0.005);
        // no artifacts: as close to a pure tone as atempo's (within 5 dB), and at least 30 dB clean
        const from = Math.round(25000 / tempo), to = Math.round(95000 / tempo);
        const mine = purity(y, f, from, to), theirs = purity(a, f, from, to);
        expect(mine, `${f} Hz: ${mine.toFixed(1)} dB vs atempo ${theirs.toFixed(1)} dB`).toBeLessThan(Math.max(theirs + 5, -30));
        expect(mine).toBeLessThan(-30);
        // the level doesn't change
        let ex = 0, ey = 0;
        for (let i = 25000; i < 95000; i++) ex += x[i] ** 2;
        for (let i = from; i < to; i++) ey += y[i] ** 2;
        expect(Math.abs(10 * Math.log10(ey / (to - from) / (ex / 70000)))).toBeLessThan(0.2);
      }
    });
    it(`tempo ${tempo}: noise keeps its spectrum`, () => {
      const r = noise(3);
      const x = Float32Array.from({ length: SR * 3 }, () => 0.2 * r());
      const y = stretch(x, tempo);
      const bx = bands(x, 8192, 120000), by = bands(y, 8192, Math.round(120000 / tempo));
      const n = Math.floor((120000 - 8192) / 4096), m = Math.floor((Math.round(120000 / tempo) - 8192) / 4096);
      bx.forEach((e, b) => expect(Math.abs(by[b] - 10 * Math.log10(m / n) - e), `band ${b}`).toBeLessThan(1.5));
    });
  }
  it("tempo 1 is the input, untouched", () => {
    const x = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i / 7));
    expect(stretch(x, 1)).toEqual(x);
  });
});

describe.skipIf(!ready)("limiter vs ffmpeg alimiter=limit=0.95:level=0", () => {
  const cases: Record<string, (i: number, r: () => number) => number> = {
    "never above the limit": (i) => 0.9 * Math.sin((2 * Math.PI * 440 * i) / SR),
    "a loud tone burst": (i) => (i > 10000 && i < 30000 ? 1.4 : 0.3) * Math.sin((2 * Math.PI * 440 * i) / SR),
    "loud noise": (i, r) => (i > 5000 && i < 40000 ? 1.3 : 0.2) * r(),
    "short clicks": (i) => (i % 9000 === 4000 ? 1.8 : 0) + 0.2 * Math.sin((2 * Math.PI * 200 * i) / SR),
  };
  for (const [name, fn] of Object.entries(cases)) {
    it(name, () => {
      const r = noise(11);
      const x = Float64Array.from({ length: 60000 }, (_, i) => fn(i, r));
      const want = f64(ffmpegRaw(x, "f64le", "alimiter=limit=0.95:level=0"));
      const got = limit(x, SR);
      expect(got.length).toBe(x.length);
      expect(want.length).toBe(x.length);
      let peak = 0, err = 0, ref = 0, maxd = 0;
      for (let i = 0; i < got.length; i++) {
        peak = Math.max(peak, Math.abs(got[i]));
        err += (got[i] - want[i]) ** 2;
        ref += want[i] ** 2;
        maxd = Math.max(maxd, Math.abs(got[i] - want[i]));
      }
      expect(peak).toBeLessThanOrEqual(0.95);
      if (name === "never above the limit") {
        // untouched, only delayed
        const D = limiterDelay(SR);
        expect(D).toBe(219);
        for (let i = 0; i < got.length; i++) expect(got[i]).toBe(i >= D ? x[i - D] : 0);
        expect(maxd).toBeLessThan(1e-12);
      } else {
        expect(err / ref, `${name}: relative error ${(err / ref).toExponential(2)}`).toBeLessThan(0.003);
      }
    });
  }
});
