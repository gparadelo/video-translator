// Which source frame goes into each output frame of a clip. This reproduces what the old Python pipeline's ffmpeg
// command does for one plan segment:
//
//   ffmpeg -ss <src_start> -t <src_len + 0.1> -i source
//          -vf setpts=(PTS-STARTPTS)/<speed>,fps=<fps>,scale=W:H,tpad=stop_mode=clone:stop=-1 -frames:v <frames>
//
// 1. Input seek (-ss, accurate): frames whose timestamp is before the seek point are dropped.
// 2. -t: frames from `src_len + 0.1` seconds after the first kept frame on are dropped.
// 3. setpts: each frame's time becomes (pts - first pts) / speed, truncated to whole ticks of the source's
//    time base (ffmpeg casts the double to an integer).
// 4. fps: output frame n shows the last frame whose new time, rounded to the nearest output frame
//    (half away from zero), is <= n. Frames that round past a later frame are dropped; gaps repeat frames.
// 5. tpad=clone + -frames:v: the last frame is held until the clip has exactly `frames` frames.
//
// Everything is done in whole ticks of the source track's time base, like ffmpeg, so ties round the same way.
// test/ffmpeg-frames.test.ts checks this against ffmpeg itself, including clips that run past the end of the
// footage by more than a second.

import { divRoundNear, ffmpegRate, pyFixed, type Rational } from "./numbers";

export type Segment = { src_start: number; src_len: number; speed: number; frames: number };

export type SegmentTiming = {
  /** Source time base: one tick is 1 / timescale seconds. */
  timescale: number;
  /** First tick that is kept (ffmpeg's seek point). */
  startTicks: number;
  /** Frames are kept while (pts - first kept pts) < durTicks. */
  durTicks: number;
  /** The speed exactly as ffmpeg parses it from the filter string. */
  speed: number;
  /** Output frame rate as ffmpeg uses it. */
  rate: Rational;
  frames: number;
};

/** Seconds as ffmpeg parses a "%.4f" option (-ss / -t): whole microseconds. */
const optionMicros = (seconds: number) => Math.round(Number(pyFixed(seconds, 4)) * 1e6);

/**
 * The numbers for one segment. `timescale` is the source track's time resolution (Mediabunny's
 * track.timeResolution); `fileStart` is the time the file starts at (ffmpeg seeks relative to it), usually 0.
 */
export function segmentTiming(seg: Segment, fps: number, timescale: number, fileStart = 0): SegmentTiming {
  if (!(timescale > 0)) throw new Error(`bad time scale ${timescale}`);
  if (!(seg.frames > 0)) throw new Error("a clip needs at least one frame");
  const startUs = optionMicros(seg.src_start) + Math.round(fileStart * 1e6);
  const durUs = optionMicros(seg.src_len + 0.1);
  // av_rescale_q(µs, 1/1000000, 1/timescale), rounding to nearest
  const ticks = (us: number) => Number(divRoundNear(BigInt(us) * BigInt(timescale), BigInt(1_000_000)));
  return {
    timescale,
    startTicks: ticks(startUs),
    durTicks: ticks(durUs),
    speed: Number(pyFixed(seg.speed, 5)),
    rate: ffmpegRate(fps),
    frames: seg.frames,
  };
}

/** Seconds range of source frames that can matter for this segment (to ask the decoder for). */
export function sourceWindow(t: SegmentTiming): { start: number; end: number } {
  return { start: t.startTicks / t.timescale, end: (t.startTicks + t.durTicks) / t.timescale };
}

/** Output frame index (within the clip) a kept source frame lands on, `ticksFromFirst` after the first kept one. */
export function outputIndex(t: SegmentTiming, ticksFromFirst: number): number {
  const shifted = Math.trunc(ticksFromFirst / t.speed); // setpts, truncated like ffmpeg's cast
  // av_rescale_q_rnd(shifted, 1/timescale, 1/rate, NEAR) = shifted * rate.num / (timescale * rate.den)
  return Number(divRoundNear(BigInt(shifted) * BigInt(t.rate.num), BigInt(t.timescale) * BigInt(t.rate.den)));
}

export type Step =
  | { kind: "before" } // before the seek point: skip it, keep decoding
  | { kind: "after" } // past the clip's source: stop decoding, then call finish()
  | { kind: "frame"; emitHeld: number }; // output the frame held so far this many times, then hold this one

/**
 * Feed it the source frames' timestamps (in ticks) in presentation order; it says what to do with each.
 * Holds at most one frame, so the caller only ever keeps one decoded frame around.
 */
export class SegmentSelector {
  private first: number | null = null;
  private heldAt = 0; // output index the held frame starts at
  private emitted = 0;
  private ended = false;

  constructor(readonly t: SegmentTiming) {}

  offer(ticks: number): Step {
    if (this.ended) return { kind: "after" };
    if (ticks < this.t.startTicks) return { kind: "before" };
    if (this.first === null) {
      this.first = ticks;
      this.heldAt = outputIndex(this.t, 0);
      return { kind: "frame", emitHeld: 0 };
    }
    if (ticks - this.first >= this.t.durTicks) {
      this.ended = true;
      return { kind: "after" };
    }
    const at = outputIndex(this.t, ticks - this.first);
    // the held frame fills output frames [emitted, at); if `at` <= emitted it is dropped unseen
    const n = Math.max(0, Math.min(at, this.t.frames) - this.emitted);
    this.emitted += n;
    this.heldAt = at;
    return { kind: "frame", emitHeld: n };
  }

  /** After the last frame: how many more times to output the held frame (to reach exactly `frames`). */
  finish(): number {
    if (this.first === null) throw new Error("no source frames in this clip");
    this.ended = true;
    const n = this.t.frames - this.emitted;
    this.emitted = this.t.frames;
    return n;
  }

  /** True once every output frame is accounted for (later source frames can't change anything). */
  get full() {
    return this.emitted >= this.t.frames;
  }
}

/**
 * For each output frame of the clip, the index (into `ticks`) of the source frame it shows.
 * `ticks` are the source frames' timestamps in presentation order.
 */
export function selectFrames(ticks: number[], t: SegmentTiming): number[] {
  const sel = new SegmentSelector(t);
  const out: number[] = [];
  let held = -1;
  for (const [i, tk] of ticks.entries()) {
    const step = sel.offer(tk);
    if (step.kind === "before") continue;
    if (step.kind === "after") break;
    for (let k = 0; k < step.emitHeld; k++) out.push(held);
    held = i;
  }
  const rest = sel.finish();
  for (let k = 0; k < rest; k++) out.push(held);
  return out;
}

/** Where output frame `index` of the whole video starts, in seconds, at the plan's frame rate. */
export const frameTime = (index: number, rate: Rational) => (index * rate.den) / rate.num;
