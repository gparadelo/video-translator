// The finished voice track of one language, as ffmpeg made it (test/reference.mjs voiceTrack): every beat's TTS clip trimmed to
// [clip_in, clip_out], at its tempo, placed at its offset; loudness matched to the original voiceover; limited;
// made stereo the way ffmpeg does it (`-ac 2`: the mono voice on both channels at -3 dB); exactly
// total_frames / fps long, 16-bit PCM at 44.1 kHz. Pure: the clips come in already decoded (decode.ts).
//
// Each step does the arithmetic ffmpeg does, in the same precision, so with every tempo at 1 the result is
// ffmpeg's sample for sample (but for the MP3 decoders' last-bit differences). Where a tempo isn't 1 the stretch
// is wsola.ts instead of atempo, and the limiter is limiter.ts instead of alimiter: close, not identical.

import { LIMITER, SAMPLE_RATE } from "./config";
import { limit } from "./limiter";
import { lufsOneDecimal } from "./loudness";
import { pyFormat, pyRound, rint } from "./py";
import { stretch } from "./wsola";

export type VoiceBeat = { offset: number; clip_in: number; clip_out: number; tempo: number };

const toS16 = (x: number) => {
  const v = rint(x * 32768);
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
};

/** ffmpeg's "<g>dB" volume: ff_exp10(g / 20), then used as a float. */
const volumeOf = (dB: number) => Math.fround(2 ** (3.321928094887362 * (dB / 20)));

export type Voice = {
  /** interleaved stereo, 16-bit */
  data: Int16Array;
  frames: number;
  /** the gain applied to match the original's loudness, in dB, and the loudness measured before it */
  gainDb: number;
  lufs: number;
};

/**
 * `clips[i]` is beat i's whole decoded clip (mono, 44.1 kHz, full scale 1). `baseLufs` is the original
 * voiceover's loudness (inputs.json analysis.base_lufs).
 */
export function buildVoice(beats: VoiceBeat[], clips: Float32Array[], totalFrames: number, fps: number, baseLufs: number): Voice {
  const SR = SAMPLE_RATE;
  const total = totalFrames / fps;
  const length = pyRound(total * SR);
  const pcm = new Int16Array(length);
  beats.forEach((b, i) => {
    const decoded = clips[i];
    const start = pyRound(b.clip_in * SR);
    const end = Math.min(decoded.length, pyRound(b.clip_out * SR));
    let part = decoded.subarray(Math.min(start, end), end);
    if (b.tempo !== 1.0) part = stretch(part, b.tempo);
    const at = pyRound(b.offset * SR);
    const n = Math.min(part.length, length - at);
    for (let k = 0; k < n; k++) pcm[at + k] = toS16(part[k]); // later beats overwrite
  });

  // loudness of the plain mix (ebur128 reads the 16-bit samples as doubles: x / 32768)
  const measured = lufsOneDecimal(pcm, SR, 1 / 32768);
  const gainDb = Number(pyFormat(baseLufs - measured, 2)); // ffmpeg's volume filter gets it with 2 decimals
  const vol = volumeOf(gainDb);
  // volume works in float: s16 -> float, times the float volume
  const loud = new Float32Array(length); // float values: no precision lost
  for (let k = 0; k < length; k++) loud[k] = Math.fround(Math.fround(pcm[k] / 32768) * vol);
  const limited = limit(loud, SR, LIMITER);
  // the file ends as ffmpeg's `-t <total, 4 decimals>` ends it: whole microseconds, to the nearest sample
  const us = Math.round(Number(pyFormat(total, 4)) * 1e6);
  const frames = Math.min(length, Math.floor((us * SR + 500_000) / 1_000_000));
  // -ac 2: the same on both channels at M_SQRT1_2, in double, then rounded to 16 bits
  const data = new Int16Array(frames * 2);
  for (let k = 0; k < frames; k++) {
    const s = toS16(limited[k] * Math.SQRT1_2);
    data[2 * k] = s;
    data[2 * k + 1] = s;
  }
  return { data, frames, gainDb, lufs: measured };
}

/** A 16-bit PCM WAV file. */
export function encodeWav(data: Int16Array, sampleRate: number, channels: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + data.byteLength);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + data.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, data.byteLength, true);
  new Int16Array(buf, 44).set(data); // little-endian on every platform browsers run on
  return buf;
}
