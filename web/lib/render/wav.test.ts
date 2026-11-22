import { describe, expect, it } from "vitest";
import { checkVoice, parsePlan, sourceSize } from "./plan";
import { parseWav } from "./wav";

function wav(samples: number[], channels = 2, extraChunk = false) {
  const data = new Int16Array(samples);
  const extra = extraChunk ? 8 + 3 + 1 : 0; // a LIST chunk of odd size, padded
  const buf = new ArrayBuffer(44 + extra + data.byteLength);
  const v = new DataView(buf);
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, buf.byteLength - 8, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 44100 * 2 * channels, true);
  v.setUint16(32, 2 * channels, true);
  v.setUint16(34, 16, true);
  let at = 36;
  if (extraChunk) {
    put(at, "LIST");
    v.setUint32(at + 4, 3, true);
    at += 12;
  }
  put(at, "data");
  v.setUint32(at + 4, data.byteLength, true);
  new Int16Array(buf, at + 8, data.length).set(data);
  return buf;
}

describe("parseWav", () => {
  it("reads 16-bit PCM", () => {
    const p = parseWav(wav([1, -1, 2, -2, 3, -3]));
    expect(p).toMatchObject({ sampleRate: 44100, channels: 2, frames: 3 });
    expect([...p.data]).toEqual([1, -1, 2, -2, 3, -3]);
  });
  it("skips other chunks", () => {
    expect([...parseWav(wav([5, 6], 1, true)).data]).toEqual([5, 6]);
  });
  it("refuses other files", () => {
    expect(() => parseWav(new ArrayBuffer(16))).toThrow(/not a WAV/);
  });
});

const plan = {
  format: 1, lang: "de", fps: 30, total_frames: 50,
  segments: [
    { seg: 0, src_start: 0, src_len: 1, speed: 1, frames: 30 },
    { seg: 1, src_start: 1, src_len: 0.6, speed: 0.95, frames: 20 },
  ],
  source: { width: 1080, height: 1920 }, voice: { file: "voice.wav", sample_rate: 44100, channels: 2 }, flags: [],
};

describe("parsePlan", () => {
  it("accepts a plan the worker wrote", () => {
    expect(parsePlan(plan).segments).toHaveLength(2);
  });
  it("refuses other formats and broken plans", () => {
    expect(() => parsePlan({ ...plan, format: 2 })).toThrow(/format 2/);
    expect(() => parsePlan({ ...plan, total_frames: 51 })).toThrow(/add up/);
    expect(() => parsePlan(null)).toThrow();
    expect(() => parsePlan({ ...plan, source: undefined })).toThrow(/size/);
    expect(() => parsePlan({ ...plan, voice: undefined })).toThrow(/voice/);
  });
});

describe("sourceSize", () => {
  const p = parsePlan(plan);
  it("renders at the size the worker's ffmpeg saw", () => {
    expect(sourceSize(p, 1080, 1920)).toEqual([1080, 1920]);
    expect(sourceSize(p, 1081, 1920)).toEqual([1080, 1920]); // e.g. non-square pixels: like the CLI
  });
  it("refuses a source this browser turns the other way", () => {
    expect(() => sourceSize(p, 1920, 1080)).toThrow(/rotation/);
  });
});

describe("checkVoice", () => {
  const p = parsePlan(plan); // 50 frames at 30 fps: 73500 samples at 44.1 kHz
  it("accepts the voice the worker made", () => {
    expect(() => checkVoice(p, { sampleRate: 44100, channels: 2, frames: 73500 })).not.toThrow();
    expect(() => checkVoice(p, { sampleRate: 44100, channels: 2, frames: 73498 })).not.toThrow();
  });
  it("refuses another format or length", () => {
    expect(() => checkVoice(p, { sampleRate: 48000, channels: 2, frames: 80000 })).toThrow(/48000/);
    expect(() => checkVoice(p, { sampleRate: 44100, channels: 1, frames: 73500 })).toThrow(/channels/);
    expect(() => checkVoice(p, { sampleRate: 44100, channels: 2, frames: 60000 })).toThrow(/long/);
  });
});
