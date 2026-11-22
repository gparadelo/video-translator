// A look-ahead peak limiter standing in for ffmpeg's `alimiter=limit=0.95:level=0` (vt.voice_filter). It is
// written here from its behaviour, not ported, and matches it where it matters:
//   * the output is the input delayed by the look-ahead (5 ms: 219 samples at 44.1 kHz; alimiter has no latency
//     compensation either), and exactly that whenever no peak is above the limit;
//   * the gain ramps down linearly over the look-ahead to limit/peak, so the peak leaves at the limit;
//   * after a peak the gain comes back up linearly over the release time (50 ms from that peak's gain to 1);
//   * the output is clipped to +-limit, like alimiter's last step.
// Deviations: when a second peak arrives while the gain is already down, alimiter ramps from where its gain is,
// this ramps as if from unity (it can start reducing a few samples earlier); alimiter's auto-release (off in
// vt.py) isn't implemented. The tests compare it with ffmpeg on signals that trigger it.

import { LIMITER } from "./config";

/** The delay in samples: alimiter's buffer of attack * rate samples, read one slot ahead of where it writes. */
export const limiterDelay = (sampleRate: number, attackMs = LIMITER.attackMs) =>
  Math.trunc((sampleRate * attackMs) / 1000) - 1;

/** Limit mono samples (full scale 1). Returns a new array of the same length (the last `delay` samples drop off). */
export function limit(input: Float64Array, sampleRate: number, opts = LIMITER): Float64Array {
  const D = limiterDelay(sampleRate, opts.attackMs);
  const A = D + 1; // the ramp length
  const n = input.length;
  const lim = opts.limit;
  // in output time: s[m] = input[m - D]
  const at = (m: number) => (m - D >= 0 && m - D < n ? input[m - D] : 0);
  // the gain each output sample may have at most: its own peak, and the ramps down to every coming peak
  const gain = new Float64Array(n).fill(1);
  const req = new Float64Array(n).fill(1);
  for (let m = 0; m < n; m++) {
    const p = Math.abs(at(m));
    if (p <= lim) continue;
    const g = lim / p;
    req[m] = g;
    const slope = (1 - g) / A;
    for (let k = 0; k <= A && m - k >= 0; k++) {
      const v = g + k * slope;
      if (v < gain[m - k]) gain[m - k] = v;
    }
  }
  // release: after a peak, the gain rises no faster than (1 - its gain) over the release time
  const releaseSamples = (sampleRate * opts.releaseMs) / 1000;
  const out = new Float64Array(n);
  let g = 1;
  let rise = 1;
  for (let m = 0; m < n; m++) {
    g = Math.min(gain[m], g + rise);
    if (req[m] < 1 && g >= req[m]) {
      g = req[m];
      rise = (1 - g) / releaseSamples;
    }
    if (g > 1) g = 1;
    const y = at(m) * g;
    out[m] = y > lim ? lim : y < -lim ? -lim : y;
  }
  return out;
}
