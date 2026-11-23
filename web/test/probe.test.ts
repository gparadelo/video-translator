// What the browser reads from a video's index (lib/prepare/probe.ts, timing.ts) against ffprobe, on the test videos
// (test/videos.mjs): the length and frame rate as ffprobe reports them, the shown size (rotation applied, as ffmpeg
// decodes it), HDR and variable frame rates; the loudness meter (LoudnessMeter, any number of channels) against
// ffmpeg's ebur128 on the decoded sound; and the file checks' decisions (judge). The browser's own decoding is
// checked by test/e2e.
//
// Needs ffmpeg; skipped otherwise.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integratedLoudness, LoudnessMeter } from "../lib/pipeline/loudness";
import { judge } from "../lib/prepare/checks";
import { rFrameRate } from "../lib/prepare/timing";
import { factsOf } from "./media-node";
import { media } from "./reference.mjs";
import { makeVideo, probe, VIDEOS } from "./videos.mjs";

const ready = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The sound as ffmpeg decodes it: one Float32Array per channel. */
function decodedSound(path: string, channels: number): Float32Array[] {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-"], { maxBuffer: 2 ** 31 - 1 });
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const n = all.length / channels;
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: n }, (_, i) => all[i * channels + c]));
}

/** Roughly what desktop Chrome decodes. */
const CHROME = { video: ["avc", "hevc", "vp8", "vp9", "av1"], audio: ["aac", "opus", "mp3", "flac", "vorbis"] };

describe.skipIf(!ready)("the video's facts as ffprobe and ffmpeg have them", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vt-probe-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const name of Object.keys(VIDEOS)) {
    it(name, async () => {
      const path = makeVideo(dir, name);
      const f = await factsOf(path);
      const p = probe(path);
      const vs = p.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      expect(f.duration).toBe(Number(p.format.duration));
      const [num, den] = vs.r_frame_rate.split("/").map(Number);
      expect(f.video!.fpsRational).toEqual([num, den]);
      expect(f.video!.fps).toBe(num / den);
      expect(f.video!.variable).toBe(name === "vfr");
      expect(f.video!.hdr || (f.video!.colorSpace.primaries as string) === "bt2020").toBe(name === "hlg" || name === "pq");
      const can = { video: CHROME.video.includes(f.video!.codec ?? ""), audio: CHROME.audio.includes(f.audio?.codec ?? "") };
      const verdict = judge(f, can);
      const refused = ["hlg", "pq", "silent", "mpeg4", "ac3", "tiny"];
      expect(verdict.ok).toBe(!refused.includes(name));
      if (!verdict.ok) {
        const why = { hlg: /HDR \(HLG\)/, pq: /HDR \(PQ\)/, silent: /no sound/, mpeg4: /can't decode this video's picture/,
                      ac3: /can't decode this video's sound \(AC-3\)/, tiny: /too short/ }[name as "hlg"];
        expect(verdict.reason).toMatch(why);
      } else if (name.startsWith("rotated")) {
        expect(verdict.notes.join(" ")).toMatch(/turned by (90|180)°/);
      } else if (name === "vfr") {
        expect(verdict.notes.join(" ")).toMatch(/frame rate varies; .* steady 60 frames/);
      }
      if (refused.includes(name)) return;

      const ff = media(path);
      expect(f.duration).toBe(ff.dur);
      expect(f.video!.fps).toBe(ff.fps);
      expect([f.video!.width, f.video!.height]).toEqual([ff.width, ff.height]);
      const sound = decodedSound(path, f.audio!.channels);
      const meter = new LoudnessMeter(f.audio!.sampleRate, sound.length);
      for (let at = 0; at < sound[0].length; at += 4096) { // fed in pieces, as the browser decodes it
        const n = Math.min(4096, sound[0].length - at);
        meter.push(sound.map((c) => c.subarray(at, at + n)), n);
      }
      expect(meter.lufs()).toBe(ff.base_lufs);
      if (sound.length === 1) expect(meter.integrated()).toBe(integratedLoudness(sound[0], f.audio!.sampleRate));
    });
  }

  it("frame rates from timestamps as ffprobe guesses them", () => {
    const frames = (n: number, d: (i: number) => number) => {
      const out = [0];
      for (let i = 1; i < n; i++) out.push(out[i - 1] + d(i));
      return out;
    };
    expect(rFrameRate(frames(100, () => 512), 15360)).toEqual([30, 1]);
    expect(rFrameRate(frames(100, () => 1001), 30000)).toEqual([30000, 1001]);
    expect(rFrameRate(frames(300, (i) => Math.round((i * 1000) / 29.97) - Math.round(((i - 1) * 1000) / 29.97)), 1000)).toEqual([30000, 1001]);
    expect(rFrameRate(frames(300, (i) => Math.round((i * 1000) / 25) - Math.round(((i - 1) * 1000) / 25)), 1000)).toEqual([25, 1]);
    expect(rFrameRate(frames(100, () => 3750), 90000)).toEqual([24, 1]);
  });
});
