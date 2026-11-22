// The browser's frame selection (lib/render/frames.ts) against ffmpeg itself: synthetic videos with the
// frame number drawn into every frame are rendered clip by clip with scripts/vt.py's own ffmpeg command
// (vt.segment_cmd), and the frame numbers that come out must be the ones selectFrames picks. Source
// timestamps are read with Mediabunny, exactly as the browser reads them.
//
// Needs ffmpeg and uv (to run vt.py); skipped otherwise. Takes about half a minute.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { segmentTiming, selectFrames, type Segment } from "../lib/render/frames";
import { fileStart as startOf } from "../lib/render/render";

const FIXTURE = resolve(__dirname, "vt_fixture.py");
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

// (name, frame rate, mp4 time scale): ffmpeg's default for 30 fps, a phone-like 29.97 fps at 1/600
// (uneven ticks per frame), 24 fps at 1/90000 and 25 fps.
const SOURCES: [string, string, number | null][] = [
  ["30", "30", null],
  ["2997", "30000/1001", 600],
  ["24", "24", 90000],
  ["25", "25", null],
];

function cases(fps: number): (Segment & { atEnd?: boolean })[] {
  const out: (Segment & { atEnd?: boolean })[] = [];
  for (const src_start of [0, 1.2345, 3.31, 5.0167])
    for (const speed of [0.9, 0.93117, 1, 1.04, 1.1])
      for (const src_len of [1, 2.37]) out.push({ src_start, speed, src_len, frames: Math.round((src_len / speed) * fps) });
  // the clip runs past the end of the 12 s source: the last frame is held
  out.push({ src_start: 10.5, speed: 0.95, src_len: 1.5, frames: 80, atEnd: true });
  out.push({ src_start: 11, speed: 1.1, src_len: 1, frames: 45, atEnd: true });
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

describe.skipIf(!ready)("frame selection matches ffmpeg (vt.segment_cmd)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vt-frames-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(SOURCES)("%s fps", async (name, rate, timescale) => {
    const src = join(dir, `src${name}.mp4`);
    py("video", src, "--rate", rate, ...(timescale ? ["--timescale", String(timescale)] : []));
    const [n, d] = rate.split("/").map(Number);
    const fps = n / (d || 1);
    const list = cases(fps);
    const file = join(dir, `cases${name}.json`);
    writeFileSync(file, JSON.stringify(list));
    const ffmpeg: number[][] = JSON.parse(py("segments", src, file));
    const source = await sourceTicks(src);
    if (timescale) expect(source.timescale).toBe(timescale);

    list.forEach((c, i) => {
      const ours = selectFrames(source.ticks, segmentTiming(c, fps, source.timescale, source.fileStart));
      const theirs = ffmpeg[i];
      const label = `${name} fps, clip ${JSON.stringify(c)}`;
      expect(ours, label).toHaveLength(c.frames);
      if (c.atEnd) {
        // ffmpeg's tpad holds the last frame for 1 s only (stop_duration=1); the browser holds it to the end
        expect(theirs.length, label).toBeLessThanOrEqual(c.frames);
        expect(ours.slice(0, theirs.length), label).toEqual(theirs);
        expect(new Set(ours.slice(theirs.length - 1)), label).toEqual(new Set([theirs.at(-1)]));
      } else {
        expect(ours, label).toEqual(theirs);
      }
    });
  });
});
