// Integrated loudness (ITU-R BS.1770 / EBU R128), measured the way ffmpeg's ebur128 filter measures it, because
// vt.py matches the new voice to the original with `ebur128` (vt.lufs): K-weighting (the BS.1770 shelf and
// high-pass, with the coefficients worked out for the actual sample rate, as libebur128 does), 400 ms blocks
// every 100 ms (only full ones), an absolute gate at -70 LUFS and a relative gate 10 LU below the mean of the
// blocks above it. Like ffmpeg, the blocks are counted in a histogram of 0.01 LU steps. Pure; one channel.

import { pyFormat } from "./py";

const ABS_THRES = -70;
const ABS_UP_THRES = 10;
const HIST_GRAIN = 100;
const HIST_SIZE = (ABS_UP_THRES - ABS_THRES) * HIST_GRAIN + 1;

const loudnessOf = (energy: number) => -0.691 + 10 * Math.log10(energy);
const energyOf = (loudness: number) => 10 ** ((loudness + 0.691) / 10);
const histPos = (lufs: number) => Math.min(HIST_SIZE - 1, Math.max(0, Math.trunc((lufs - ABS_THRES) * HIST_GRAIN)));

let histEnergy: Float64Array | null = null;

/** The K-weighting filters for a sample rate: [pre b, pre a, rlb b, rlb a]. */
export function kWeighting(sampleRate: number) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20.0);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1.0 + K / Q + K * K;
  const preB = [(Vh + (Vb * K) / Q + K * K) / a0, (2.0 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0];
  const preA = [1.0, (2.0 * (K * K - 1.0)) / a0, (1.0 - K / Q + K * K) / a0];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  const rlbB = [1.0, -2.0, 1.0];
  const rlbA = [1.0, (2.0 * (K * K - 1.0)) / (1.0 + K / Q + K * K), (1.0 - K / Q + K * K) / (1.0 + K / Q + K * K)];
  return { preB, preA, rlbB, rlbA };
}

/**
 * Integrated loudness in LUFS of mono samples (full scale = 1, or 1 / scale: 16-bit samples with scale 1 / 32768,
 * which is exactly how ffmpeg reads them). Returns -70 when no block is above the absolute gate (what ffmpeg
 * reports for silence).
 */
export function integratedLoudness(samples: ArrayLike<number>, sampleRate: number, onBlock?: (loudness: number, power: number) => void,
                                   scale = 1): number {
  histEnergy ??= Float64Array.from({ length: HIST_SIZE }, (_, i) => energyOf(i / HIST_GRAIN + ABS_THRES));
  const { preB, preA, rlbB, rlbA } = kWeighting(sampleRate);
  const size = Math.trunc((sampleRate * 4) / 10); // 400 ms
  const step = Math.trunc(sampleRate / 10); // a block every 100 ms
  const cache = new Float64Array(size);
  const counts = new Uint32Array(HIST_SIZE);
  let pos = 0, filled = false, sum = 0, count = 0;
  let y1 = 0, y2 = 0, z1 = 0, z2 = 0;
  let keptPowers = 0, keptBlocks = 0;
  let integrated = ABS_THRES;
  for (let i = 0; i < samples.length; i++) {
    const bin = pos;
    if (++pos === size) {
      filled = true;
      pos = 0;
    }
    // two biquads in transposed direct form II, as ffmpeg runs them
    const x = samples[i] * scale;
    const y = preB[0] * x + y1;
    y1 = preB[1] * x + y2 - preA[1] * y;
    y2 = preB[2] * x - preA[2] * y;
    const z = rlbB[0] * y + z1;
    z1 = rlbB[1] * y + z2 - rlbA[1] * z;
    z2 = rlbB[2] * y - rlbA[2] * z;
    const e = z * z;
    sum = sum + e - cache[bin]; // a running sum, as ffmpeg keeps it
    cache[bin] = e;
    if (++count !== step) continue;
    count = 0;
    let power = 1e-12;
    if (filled) power = (power + sum) / size;
    const loud = loudnessOf(power);
    onBlock?.(loud, power);
    if (!(loud >= ABS_THRES)) continue; // also NaN: the running sum can drift just below 0 in silence
    counts[histPos(loud)]++;
    keptPowers += power;
    keptBlocks++;
    let rel = keptPowers / keptBlocks;
    if (!rel) rel = 1e-12;
    const gate = histPos(loudnessOf(rel) - 10);
    let n = 0, s = 0;
    for (let h = gate; h < HIST_SIZE; h++) {
      n += counts[h];
      s += counts[h] * histEnergy[h];
    }
    if (n) integrated = loudnessOf(s / n);
  }
  return integrated;
}

/** What vt.lufs reads from ffmpeg's summary ("I: -18.4 LUFS"): the integrated loudness with one decimal. */
export const lufsOneDecimal = (samples: ArrayLike<number>, sampleRate: number, scale = 1) =>
  Number(pyFormat(integratedLoudness(samples, sampleRate, undefined, scale), 1));

