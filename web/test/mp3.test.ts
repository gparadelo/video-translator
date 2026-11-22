// lib/pipeline/mp3.ts against ffmpeg: the gapless info it reads gives ffmpeg's decoded length, and a clip
// decoded whole (as a browser that ignores the LAME header would) is cut to exactly ffmpeg's samples.
// Needs ffmpeg; skipped otherwise.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gaplessLength, mp3Gapless, trimLikeFfmpeg } from "../lib/pipeline/mp3";

const ready = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const dir = mkdtempSync(join(tmpdir(), "vt-mp3-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const decode = (file: string) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-"], { maxBuffer: 1 << 26 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
};

/** The file without its ID3 tag and Info frame: ffmpeg then decodes every frame and cuts nothing. */
function withoutInfo(bytes: Uint8Array): Uint8Array {
  let at = 0;
  if (String.fromCharCode(...bytes.subarray(0, 3)) === "ID3")
    at = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
  const mpeg1 = ((bytes[at + 1] >> 3) & 3) === 3;
  const bitrates = mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const rates = mpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000];
  const kbps = bitrates[bytes[at + 2] >> 4], rate = rates[(bytes[at + 2] >> 2) & 3], pad = (bytes[at + 2] >> 1) & 1;
  const size = Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / rate) + pad;
  return bytes.subarray(at + size);
}

describe.skipIf(!ready)("MP3 gapless info", () => {
  for (const [rate, kbps, seconds] of [[44100, 128, 1.2345], [44100, 64, 0.3], [22050, 64, 2.01]] as const) {
    it(`${rate} Hz ${kbps} kb/s ${seconds} s: decoded whole, cut like ffmpeg`, () => {
      const file = join(dir, `t${rate}-${kbps}.mp3`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=440:d=${seconds}:sample_rate=${rate}`,
        "-ac", "1", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, file]);
      const bytes = new Uint8Array(readFileSync(file));
      const g = mp3Gapless(bytes);
      expect(g).not.toBeNull();
      const cut = decode(file);
      expect(gaplessLength(g!)).toBe(cut.length);
      expect(trimLikeFfmpeg(cut, g)).toBe(cut); // already cut: unchanged

      const rawFile = join(dir, `raw${rate}-${kbps}.mp3`);
      writeFileSync(rawFile, withoutInfo(bytes));
      expect(mp3Gapless(new Uint8Array(readFileSync(rawFile)))).toBeNull();
      const whole = decode(rawFile);
      expect(whole.length).toBe(g!.frames * g!.samplesPerFrame);
      expect([...trimLikeFfmpeg(whole, g)]).toEqual([...cut]);
      // a decoder that also decodes the Info frame (one frame of silence first)
      const withInfo = new Float32Array(whole.length + g!.samplesPerFrame);
      withInfo.set(whole, g!.samplesPerFrame);
      expect([...trimLikeFfmpeg(withInfo, g)]).toEqual([...cut]);
    });
  }

  it("leaves files without gapless info, and lengths it can't explain, alone", () => {
    const x = new Float32Array(1000);
    expect(trimLikeFfmpeg(x, null)).toBe(x);
    expect(trimLikeFfmpeg(x, { frames: 3, samplesPerFrame: 1152, delay: 576, padding: 1000 })).toBe(x);
    expect(mp3Gapless(new Uint8Array([0x49, 0x44, 0x33]))).toBeNull();
    expect(mp3Gapless(new Uint8Array(10))).toBeNull();
  });
});
