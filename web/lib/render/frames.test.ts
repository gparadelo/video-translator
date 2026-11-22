import { describe, expect, it } from "vitest";
import { outputIndex, SegmentSelector, segmentTiming, selectFrames, sourceWindow, type Segment } from "./frames";

// A 30 fps source with ffmpeg's usual mp4 time base (1/15360): frame k is at tick 512 k.
const TS = 15360;
const ticks30 = (n: number) => Array.from({ length: n }, (_, k) => 512 * k);
const seg = (s: Partial<Segment>): Segment => ({ src_start: 0, src_len: 1, speed: 1, frames: 30, ...s });

describe("segmentTiming", () => {
  it("turns the plan's seconds into source ticks the way ffmpeg parses them", () => {
    const t = segmentTiming(seg({ src_start: 1.23456, src_len: 2, speed: 1.0412345 }), 30, TS);
    expect(t.startTicks).toBe(Math.round(1.2346 * TS)); // -ss %.4f
    expect(t.durTicks).toBe(Math.round(2.1 * TS)); // -t (src_len + 0.1)
    expect(t.speed).toBe(1.04123); // %.5f
    expect(t.rate).toEqual({ num: 30, den: 1 });
    expect(sourceWindow(t).start).toBeCloseTo(1.2346, 3);
  });
  it("seeks relative to the start of the file", () => {
    expect(segmentTiming(seg({ src_start: 1 }), 30, 600, 0.5).startTicks).toBe(900);
  });
});

describe("selectFrames", () => {
  it("is the identity at speed 1 and the same frame rate", () => {
    const t = segmentTiming(seg({ src_start: 2, frames: 30 }), 30, TS);
    expect(selectFrames(ticks30(360), t)).toEqual(Array.from({ length: 30 }, (_, k) => 60 + k));
  });
  it("skips frames when sped up and repeats them when slowed down", () => {
    const fast = selectFrames(ticks30(360), segmentTiming(seg({ speed: 1.1, frames: 30 }), 30, TS));
    const slow = selectFrames(ticks30(360), segmentTiming(seg({ speed: 0.9, frames: 30 }), 30, TS));
    expect(fast).toHaveLength(30);
    expect(slow).toHaveLength(30);
    expect(fast.at(-1)).toBeGreaterThan(29); // shows more than a second of source
    expect(slow.at(-1)).toBeLessThan(29);
    expect(new Set(fast).size).toBe(30); // nothing repeated
    expect(new Set(slow).size).toBeLessThan(30); // something repeated
    for (let k = 1; k < 30; k++) expect(fast[k]).toBeGreaterThan(fast[k - 1]);
  });
  it("holds the last frame when the source runs out (tpad=clone)", () => {
    const t = segmentTiming(seg({ src_start: 11, src_len: 1, frames: 50 }), 30, TS);
    const out = selectFrames(ticks30(360), t);
    expect(out).toHaveLength(50);
    expect(out.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, k) => 330 + k));
    expect(new Set(out.slice(29))).toEqual(new Set([359]));
  });
  it("starts at the first frame at or after the seek point", () => {
    const t = segmentTiming(seg({ src_start: 1.01, frames: 3 }), 30, TS); // between frames 30 and 31
    expect(selectFrames(ticks30(360), t)).toEqual([31, 32, 33]);
  });
  it("matches the frame rate conversion at a different output rate", () => {
    // 30 fps source, 25 fps output at speed 1: output frame n shows the last source frame with round(t * 25) <= n
    const t = segmentTiming(seg({ frames: 25 }), 25, TS);
    const out = selectFrames(ticks30(60), t);
    out.forEach((src, n) => {
      expect(outputIndex(t, src * 512)).toBeLessThanOrEqual(n);
      expect(outputIndex(t, (src + 1) * 512)).toBeGreaterThan(n);
    });
  });
});

describe("SegmentSelector", () => {
  it("tells the renderer what to do with each decoded frame and holds one at a time", () => {
    const s = new SegmentSelector(segmentTiming(seg({ src_start: 1, src_len: 0.1, frames: 5 }), 30, TS));
    expect(s.offer(512 * 29)).toEqual({ kind: "before" });
    expect(s.offer(512 * 30)).toEqual({ kind: "frame", emitHeld: 0 });
    expect(s.offer(512 * 31)).toEqual({ kind: "frame", emitHeld: 1 });
    expect(s.offer(512 * 32)).toEqual({ kind: "frame", emitHeld: 1 });
    // -t is src_len + 0.1 = 0.2 s = 6 frames from the first kept one
    for (let k = 33; k < 36; k++) expect(s.offer(512 * k).kind).toBe("frame");
    expect(s.offer(512 * 36)).toEqual({ kind: "after" });
    expect(s.full).toBe(true);
    expect(s.finish()).toBe(0);
  });
  it("needs at least one frame", () => {
    expect(() => new SegmentSelector(segmentTiming(seg({}), 30, TS)).finish()).toThrow();
  });
});
