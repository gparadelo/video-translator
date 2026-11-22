// prep/media.json: what the browser measured of the video itself (lib/prepare/local.ts), the part of vt.cmd_analyze
// that needs the video (ffprobe, the cuts, the loudness), so the routes never need the video: its length and frame
// rate as ffprobe reports them, the size it's shown at, the cuts (vt.detect_cuts), the loudness (vt.lufs), and which
// file in prep/ is the voiceover sent to ElevenLabs. Written once per project; the routes check it (parseMedia)
// before using it. Safe in the browser.

import { ProduceError } from "../produce/errors";
import type { VideoMeasures } from "./analyze";

export const MEDIA_FORMAT = 1;

/** The voiceover the browser extracted: AAC in MP4 (as vt.py's base_vo.m4a) or, without an AAC encoder, WAV. */
export const AUDIO_FILES = { "audio.m4a": "audio/mp4", "audio.wav": "audio/wav" } as const;
export type AudioFile = keyof typeof AUDIO_FILES;

export type Media = VideoMeasures & {
  format: number;
  /** vt.detect_cuts: seconds, on the frame grid, sorted */
  cuts: number[];
  audio: AudioFile;
  audio_bytes: number;
  /** where these came from: "browser" (measured), or "analysis" (an older worker's analysis.json) */
  from: "browser" | "analysis";
  /** for the person and for debugging: frames read, whether the frame rate varies */
  frames?: number;
  variable_fps?: boolean;
};

/** The voiceover's file at most (128 kb/s AAC is ~1 MB a minute; 16-bit WAV at 48 kHz ~6 MB a minute). */
export const MAX_AUDIO_BYTES = 100_000_000;
export const MAX_MEDIA_BYTES = 1_000_000;

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const int = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

/** Check a media.json and return it typed. */
export function parseMedia(json: unknown): Media {
  const m = json as Partial<Media> | null;
  const bad = (what: string) => new ProduceError(`the measurements of the video can't be used (${what}) - measuring it again`, { status: 422, code: "stale" });
  if (!m || typeof m !== "object" || m.format !== MEDIA_FORMAT) throw bad("format");
  if (!num(m.dur) || m.dur <= 0 || m.dur > 24 * 3600) throw bad("length");
  if (!num(m.fps) || m.fps <= 0 || m.fps > 1000) throw bad("frame rate");
  if (!int(m.width, 1, 16384) || !int(m.height, 1, 16384)) throw bad("size");
  if (!num(m.base_lufs) || m.base_lufs < -200 || m.base_lufs > 10) throw bad("loudness");
  if (!Array.isArray(m.cuts) || m.cuts.length > 10_000 || !m.cuts.every(num)) throw bad("cuts");
  for (let i = 1; i < m.cuts.length; i++) if (!(m.cuts[i] > m.cuts[i - 1])) throw bad("cuts out of order");
  if (m.cuts.some((t) => !(t > 0.05 && t < m.dur! - 0.05))) throw bad("a cut outside the video");
  if (!m.audio || !(m.audio in AUDIO_FILES)) throw bad("no voiceover");
  if (!int(m.audio_bytes, 1, MAX_AUDIO_BYTES)) throw bad("voiceover size");
  if (m.from !== "browser" && m.from !== "analysis") throw bad("origin");
  return m as Media;
}
