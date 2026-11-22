// An MP3's gapless info (the Xing/Info frame and its LAME tag), so a clip decodes to exactly the samples ffmpeg
// gives vt.py whatever the browser's decoder does with the encoder delay and padding. Chrome and Edge already
// cut them as ffmpeg does; a decoder that doesn't hands back every decoded frame, and this cuts them the same
// way. Pure.
//
// ffmpeg (libavformat/mp3dec.c): with an Info/Xing frame that counts the frames, and a LAME tag written by LAME
// or libavcodec, it skips delay + 529 samples (the encoder's delay plus the decoder's) and keeps
// frames * samples_per_frame - delay - padding samples. Without them it keeps everything.

export type Gapless = { frames: number; samplesPerFrame: number; delay: number; padding: number };

const DECODER_DELAY = 529;

const tag = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** The gapless info of an MP3 file, or null when it has none ffmpeg would use. */
export function mp3Gapless(bytes: Uint8Array): Gapless | null {
  let at = 0;
  if (tag(bytes, 0).startsWith("ID3") && bytes.length >= 10) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    at = 10 + size + (bytes[5] & 0x10 ? 10 : 0);
  }
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1] >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
  const layer = (bytes[at + 1] >> 1) & 3; // 1: Layer III
  if (layer !== 1 || version === 1) return null;
  const mono = bytes[at + 3] >> 6 === 3;
  const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  let p = at + 4 + sideInfo;
  const name = tag(bytes, p);
  if (name !== "Xing" && name !== "Info") return null;
  const flags = u32(bytes, p + 4);
  p += 8;
  if (!(flags & 1)) return null; // no frame count: ffmpeg can't cut the end either
  const frames = u32(bytes, p);
  p += 4;
  if (flags & 2) p += 4; // bytes
  if (flags & 4) p += 100; // seek table
  if (flags & 8) p += 4; // quality
  if (p + 24 > bytes.length) return null;
  const encoder = tag(bytes, p);
  if (encoder !== "LAME" && encoder !== "Lavf" && encoder !== "Lavc") return null;
  const v = (bytes[p + 21] << 16) | (bytes[p + 22] << 8) | bytes[p + 23];
  return { frames, samplesPerFrame: version === 3 ? 1152 : 576, delay: v >> 12, padding: v & 0xfff };
}

/** How many samples ffmpeg decodes the file to. */
export const gaplessLength = (g: Gapless) => g.frames * g.samplesPerFrame - g.delay - g.padding;

/**
 * Cut a decoded clip like ffmpeg does. Decoded already cut (Chrome, Edge): unchanged. Decoded whole (every
 * frame, with or without the Info frame as one frame of silence): the delay and the padding cut off. Anything
 * else, or no gapless info: unchanged.
 */
export function trimLikeFfmpeg(samples: Float32Array, g: Gapless | null): Float32Array {
  if (!g) return samples;
  const want = gaplessLength(g);
  if (want <= 0 || samples.length === want) return samples;
  for (const extra of [0, g.samplesPerFrame]) {
    if (samples.length !== g.frames * g.samplesPerFrame + extra) continue;
    const start = extra + g.delay + DECODER_DELAY;
    return samples.subarray(start, Math.min(samples.length, start + want));
  }
  return samples;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * How many samples a clip decodes to, without decoding it: from its gapless info (what the browser and ffmpeg
 * give, see trimLikeFfmpeg), or else every MPEG Layer III frame counted (what a decoder gives without that info).
 * Null when it isn't an MP3. The produce steps use it to fit a language before the browser decodes the clips.
 */
export function mp3Samples(bytes: Uint8Array): number | null {
  const g = mp3Gapless(bytes);
  if (g) return Math.max(0, gaplessLength(g));
  let at = 0;
  if (tag(bytes, 0).startsWith("ID3") && bytes.length >= 10) {
    at = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)) +
      (bytes[5] & 0x10 ? 10 : 0);
  }
  let frames = 0, spf = 0;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) break;
    const version = (bytes[at + 1] >> 3) & 3, layer = (bytes[at + 1] >> 1) & 3;
    const bi = bytes[at + 2] >> 4, ri = (bytes[at + 2] >> 2) & 3, pad = (bytes[at + 2] >> 1) & 1;
    if (layer !== 1 || version === 1 || bi === 0 || bi === 15 || ri === 3) break;
    const v1 = version === 3;
    const rate = RATES[version][ri];
    const kbps = (v1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bi];
    const len = Math.floor(((v1 ? 144 : 72) * kbps * 1000) / rate) + pad;
    if (len < 4) break;
    spf = v1 ? 1152 : 576;
    frames++;
    at += len;
  }
  return frames ? frames * spf : null;
}
