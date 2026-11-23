// Time stretching without changing pitch (WSOLA: waveform-similarity overlap-add), for the small tempo changes
// the timing plan makes to a beat's voice (about 0.96 to 1.07). It stands in for ffmpeg's atempo.
//
// The output is cut into 23 ms Hann windows that overlap by half. Each window is taken from the input near
// where the tempo says it should come from, shifted by up to +-8.7 ms to the spot whose waveform best continues
// what was already written (normalized cross-correlation, searched on a 4x decimated copy and refined at full
// rate), so the overlaps add up in phase: no echo, no clicks, no pitch change. The output starts exactly like
// the input and is exactly round(length / tempo) samples long (atempo loses up to ~15 ms at the end).

import { pyRound } from "./py";

const N = 1024; // window, samples (23 ms at 44.1 kHz)
const HOP = N / 2; // output hop
const SEARCH = 384; // +- samples the window may move (8.7 ms: more than half the longest voice period)
const DEC = 4; // decimation for the coarse search

let hann: Float64Array | null = null;

/** Output length for `n` input samples at `tempo` (> 1 is faster, i.e. shorter). */
export const stretchedLength = (n: number, tempo: number) => pyRound(n / tempo);

export function stretch(x: Float32Array, tempo: number): Float32Array {
  if (!(tempo > 0.5 && tempo < 2)) throw new Error(`tempo ${tempo} is out of range`);
  const outLen = stretchedLength(x.length, tempo);
  if (tempo === 1) return x.slice(0, outLen);
  hann ??= Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const w = hann;
  const n = x.length;
  const sample = (i: number) => (i >= 0 && i < n ? x[i] : 0);
  // decimated copy for the coarse search (box filter)
  const dn = Math.ceil(n / DEC);
  const xd = new Float64Array(dn);
  for (let i = 0; i < dn; i++) {
    let s = 0;
    for (let k = 0; k < DEC; k++) s += sample(i * DEC + k);
    xd[i] = s / DEC;
  }
  const dsample = (i: number) => (i >= 0 && i < dn ? xd[i] : 0);

  const acc = new Float64Array(outLen + N);
  const wsum = new Float64Array(outLen + N);
  let prev = 0; // where the previous window was taken from
  for (let k = 0; k * HOP < outLen; k++) {
    let pos: number;
    if (k === 0) pos = 0;
    else {
      const nominal = Math.round(k * HOP * tempo);
      const natural = prev + HOP; // what would continue the previous window seamlessly
      const lo = Math.max(-SEARCH, -nominal);
      const hi = SEARCH;
      // Similarity: normalized cross-correlation (-1..1) of the candidate's first half with the natural
      // continuation, minus a slight preference for staying where the tempo says. On periodic sounds many
      // shifts fit about equally well, and where there is nothing to match (silence before a word) every shift
      // ties: without it the windows would drift to one end of the search and move the words by up to 9 ms.
      const score = (xy: number, xx: number, yy: number, d: number) =>
        (xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0) - (0.05 * Math.abs(d)) / SEARCH;
      // coarse, on the decimated copy
      const L = HOP / DEC;
      const nd = Math.round(natural / DEC);
      let xx = 0;
      for (let i = 0; i < L; i++) xx += dsample(nd + i) ** 2;
      let best = 0, bestScore = -Infinity;
      for (let d = Math.ceil(lo / DEC); d <= Math.floor(hi / DEC); d++) {
        const c = Math.round(nominal / DEC) + d;
        let xy = 0, yy = 0;
        for (let i = 0; i < L; i++) {
          const a = dsample(nd + i), b = dsample(c + i);
          xy += a * b;
          yy += b * b;
        }
        const sc = score(xy, xx, yy, d * DEC);
        if (sc > bestScore) {
          bestScore = sc;
          best = d * DEC;
        }
      }
      // fine: +-DEC around the coarse best, at full rate
      xx = 0;
      for (let i = 0; i < HOP; i++) xx += sample(natural + i) ** 2;
      let fine = best;
      bestScore = -Infinity;
      for (let d = Math.max(lo, best - DEC); d <= Math.min(hi, best + DEC); d++) {
        const c = nominal + d;
        let xy = 0, yy = 0;
        for (let i = 0; i < HOP; i++) {
          const a = sample(natural + i), b = sample(c + i);
          xy += a * b;
          yy += b * b;
        }
        const sc = score(xy, xx, yy, d);
        if (sc > bestScore) {
          bestScore = sc;
          fine = d;
        }
      }
      pos = nominal + fine;
    }
    const o = k * HOP;
    for (let i = 0; i < N; i++) {
      acc[o + i] += w[i] * sample(pos + i);
      wsum[o + i] += w[i];
    }
    prev = pos;
  }
  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) y[i] = wsum[i] > 1e-9 ? acc[i] / wsum[i] : sample(i);
  return y;
}
