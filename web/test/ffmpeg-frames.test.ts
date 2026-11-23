// The browser's frame selection (lib/render/frames.ts) against ffmpeg itself: synthetic videos with the frame
// number drawn into every frame are rendered clip by clip with ffmpeg's retiming command (test/reference.mjs
// segmentCmd: setpts, fps, scale, tpad, the command the old CLI renders used), and the frame numbers that come out
// must be the ones selectFrames picks. Source timestamps are read with Mediabunny, exactly as the browser reads them.
//
// Needs ffmpeg; skipped otherwise. Takes about half a minute.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { segmentTiming, selectFrames, type Segment } from "../lib/render/frames";
import { fileStart as startOf } from "../lib/render/render";
import { frameVideo, segmentCodes } from "./reference.mjs";

const ready = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// (name, frame rate, mp4 time scale): ffmpeg's default for 30 fps, a phone-like 29.97 fps at 1/600
// (uneven ticks per frame), 24 fps at 1/90000 and 25 fps.
const SOURCES: [string, string, number | null][] = [
  ["30", "30", null],
  ["2997", "30000/1001", 600],
  ["24", "24", 90000],
  ["25", "25", null],
];

function cases(fps: number): Segment[] {
  const out: Segment[] = [];
  for (const src_start of [0, 1.2345, 3.31, 5.0167])
    for (const speed of [0.9, 0.93117, 1, 1.04, 1.1])
      for (const src_len of [1, 2.37]) out.push({ src_start, speed, src_len, frames: Math.round((src_len / speed) * fps) });
  // the clip runs past the end of the 12 s source: the last frame is held (here for up to 3 s)
  out.push({ src_start: 10.5, speed: 0.95, src_len: 1.5, frames: 80 });
  out.push({ src_start: 11, speed: 1.1, src_len: 1, frames: 45 });
  out.push({ src_start: 11, speed: 1, src_len: 1, frames: Math.round(4 * fps) });
  return out;
}

async function sourceTicks(path: string) {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  const timescale = await track.getTimeResolution();
  const fileStart = await startOf(input);
  const ticks: number[] = [];
  const sink = new EncodedPacketSink(track);
  for await (const p of sink.packets()) ticks.push(Math.round(p.timestamp * timescale));
  input.dispose();
  return { ticks: ticks.sort((a, b) => a - b), timescale, fileStart };
}

describe.skipIf(!ready)("frame selection matches ffmpeg's retiming", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vt-frames-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(SOURCES)("%s fps", async (name, rate, timescale) => {
    const src = frameVideo(join(dir, `src${name}.mp4`), { rate, timescale });
    const [n, d] = rate.split("/").map(Number);
    const fps = n / (d || 1);
    const list = cases(fps);
    const ffmpeg: number[][] = segmentCodes(src, list);
    const source = await sourceTicks(src);
    if (timescale) expect(source.timescale).toBe(timescale);

    list.forEach((c, i) => {
      const ours = selectFrames(source.ticks, segmentTiming(c, fps, source.timescale, source.fileStart));
      const label = `${name} fps, clip ${JSON.stringify(c)}`;
      expect(ours, label).toHaveLength(c.frames);
      expect(ours, label).toEqual(ffmpeg[i]);
    });
  });
});
