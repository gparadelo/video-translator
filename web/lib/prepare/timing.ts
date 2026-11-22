// A video's frame rate and length the way scripts/vt.py reads them from ffprobe (vt.cmd_analyze: `r_frame_rate`
// as a float, and the format's `duration`), worked out from the frames' timestamps. Pure; lib/prepare/probe.ts
// reads the timestamps with Mediabunny (in the browser, and in Node for the tests).

/** Greatest common divisor of two non-negative integers. */
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** av_reduce for positive integers. */
export const reduce = (num: number, den: number): [number, number] => {
  const g = gcd(num, den);
  return [num / g, den / g];
};

/** libavformat's standard frame rates, times 1001 * 12 (get_std_framerate). */
const STD = (() => {
  const out: number[] = [];
  for (let i = 0; i < 30 * 12; i++) out.push((i + 1) * 1001);
  for (let i = 0; i < 30; i++) out.push((i + 31) * 1001 * 12);
  for (const r of [80, 120, 240]) out.push(r * 1001 * 12);
  for (const r of [24, 30, 60, 12, 15, 48]) out.push(r * 1000 * 12);
  return out;
})();

/**
 * ffprobe's r_frame_rate of an MP4/MOV video track from its frames' presentation times in ticks of the track's
 * time scale, in order. When every frame lasts the same number of ticks (what editors and phones write), it's
 * time scale / ticks per frame (mov.c). Otherwise ffmpeg guesses (libavformat/demux.c ff_rfps_calculate): from the
 * greatest common divisor of the frame durations when it's coarse enough, or else the "standard" frame rate the
 * timestamps fit best. The guess here looks at every frame; ffmpeg looks at the first ones, so for a frame rate
 * that changes later in the file the two can differ (only for files whose frame rate really varies).
 */
export function rFrameRate(ticks: number[], timescale: number): [number, number] {
  const d: number[] = [];
  for (let i = 1; i < ticks.length; i++) if (ticks[i] > ticks[i - 1]) d.push(ticks[i] - ticks[i - 1]);
  if (!d.length) return [timescale, 1];
  if (d.every((x) => x === d[0])) return reduce(timescale, d[0]);

  const g = d.reduce(gcd);
  if (d.length > 15 && g > Math.max(1, Math.floor(timescale / 500))) return reduce(timescale, g);

  // ff_rfps_add_frame for every frame, then ff_rfps_calculate's choice
  const err = [[new Float64Array(STD.length), new Float64Array(STD.length)], [new Float64Array(STD.length), new Float64Array(STD.length)]];
  let count = 0, sum = 0;
  for (let i = 1; i < ticks.length; i++) {
    if (!(ticks[i] > ticks[i - 1])) continue;
    const dts = ticks[i] / timescale;
    for (let s = 0; s < STD.length; s++) {
      if (!(err[0][1][s] < 1e10)) continue;
      const sdts = (dts * STD[s]) / (1001 * 12);
      for (let j = 0; j < 2; j++) {
        const t = Math.round(sdts + j * 0.5); // llrint (exact halves never come up here)
        const e = sdts - t + j * 0.5;
        err[j][0][s] += e;
        err[j][1][s] += e * e;
      }
    }
    count++;
    sum += ticks[i] - ticks[i - 1];
    if (count % 10 === 0) {
      for (let s = 0; s < STD.length; s++) {
        if (!(err[0][1][s] < 1e10)) continue;
        const a0 = err[0][0][s] / count, e0 = err[0][1][s] / count - a0 * a0;
        const a1 = err[1][0][s] / count, e1 = err[1][1][s] / count - a1 * a1;
        if (e0 > 0.04 && e1 > 0.04) err[0][1][s] = err[1][1][s] = 2e10;
      }
    }
  }
  let num = 0, best = 0.01;
  const analyzed = sum / timescale; // codec_info_duration, in seconds
  for (let s = 0; s < STD.length; s++) {
    if (analyzed < (1001 * 11.5) / STD[s]) continue;
    if (sum / timescale / count < (1001 * 12.0 * 0.8) / STD[s]) continue;
    for (let k = 0; k < 2; k++) {
      const a = err[k][0][s] / count;
      const e = err[k][1][s] / count - a * a;
      if (e < best && best > 0.000000001) {
        best = e;
        num = STD[s];
      }
    }
  }
  if (num && num / (12 * 1001) < 1.01 * timescale) return reduce(num, 12 * 1001);
  return reduce(timescale, g);
}

/** Whether the frames really come at different rates (not just rounding of a constant rate to the time scale). */
export function variableFrameRate(ticks: number[]): boolean {
  let lo = Infinity, hi = 0;
  for (let i = 1; i < ticks.length; i++) {
    const x = ticks[i] - ticks[i - 1];
    if (x <= 0) continue;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return hi > 0 && hi - lo > 1 && hi > lo * 1.05;
}

/** ffprobe's format duration as vt.py reads it: whole microseconds (it prints "%f"). */
export const probeDuration = (seconds: number) => Math.round(seconds * 1e6) / 1e6;
