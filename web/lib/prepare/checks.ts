// The checks a video gets as soon as it is picked, before anything is uploaded: can this browser read it, and will
// the app make good translations of it? It reads the file's index only (Mediabunny, no decoding) and asks WebCodecs
// whether this browser decodes its picture and sound. Either the video is accepted (with notes for the person
// where something is unusual but fine), or refused with a plain reason and what to do instead. Browser only.

import { canEncodeAudio, type Input } from "mediabunny";
import { LIMITS } from "./config";
import { openInput } from "./local";
import { readFacts, type VideoFacts } from "./probe";

export const UNSUPPORTED_BROWSER =
  "This browser can't read videos the way the app needs. Use Chrome or Edge on a computer (Windows or Mac).";

export type Check =
  | { ok: true; summary: string; notes: string[]; facts: VideoFacts }
  | { ok: false; reason: string; facts: VideoFacts | null };

/** null when this browser has what the analysis needs; otherwise the message to show. */
export function browserProblem(): string | null {
  if (typeof window === "undefined") return UNSUPPORTED_BROWSER;
  const w = window as unknown as Record<string, unknown>;
  for (const api of ["VideoDecoder", "AudioDecoder", "VideoFrame", "Worker", "OffscreenCanvas"]) if (!(api in w)) return UNSUPPORTED_BROWSER;
  return null;
}

/** Phones and tablets: the app is made for Chrome and Edge on a computer. */
export const onPhone = () =>
  typeof navigator !== "undefined" && ((navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true ||
    /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));

const CODECS: Record<string, string> = { avc: "H.264", hevc: "HEVC (H.265)", vp9: "VP9", av1: "AV1", vp8: "VP8", aac: "AAC", opus: "Opus", mp3: "MP3", flac: "FLAC", ac3: "AC-3", eac3: "E-AC-3" };
const codecName = (c: string | null) => (c ? CODECS[c] ?? c.toUpperCase() : "an unknown format");
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const rate = (fps: number) => (Math.abs(fps - Math.round(fps)) < 0.01 ? String(Math.round(fps)) : fps.toFixed(2));

const EXPORT_SDR = "Export it again as SDR (Rec. 709) and upload that: in CapCut, Premiere or DaVinci turn HDR off in the export " +
  "settings; on an iPhone, AirDrop or share it with “Most Compatible”, or turn off Settings → Camera → Formats → HDR Video for new videos.";

/** What the checks decide from the file's facts and what this browser can decode. */
export function judge(f: VideoFacts, can: { video: boolean; audio: boolean }): Check {
  const v = f.video;
  if (!v) return { ok: false, reason: "This file has no picture. Choose the finished video (.mp4 or .mov).", facts: f };
  if (!can.video) {
    return { ok: false, facts: f, reason: `This browser can't decode this video's picture (${codecName(v.codec)}). ` +
      "Export it as an H.264 MP4 (the most common setting) and upload that, or use Chrome or Edge on a computer." };
  }
  const cs = v.colorSpace as { transfer?: string | null; primaries?: string | null };
  if (v.hdr || cs.transfer === "pq" || cs.transfer === "hlg") {
    return { ok: false, facts: f, reason: `This video is HDR (${cs.transfer === "pq" ? "PQ" : cs.transfer === "hlg" ? "HLG" : "high dynamic range"}). ` +
      "The translated videos would come out with washed-out, wrong colours, because the browser can only make them in SDR. " + EXPORT_SDR };
  }
  if (cs.primaries === "bt2020") {
    return { ok: false, facts: f, reason: "This video uses wide colour (BT.2020). The translated videos would come out with wrong colours. " + EXPORT_SDR };
  }
  if (!f.audio) {
    return { ok: false, facts: f, reason: "This video has no sound. The app translates the voiceover, so upload the version with the voiceover in it." };
  }
  if (!can.audio) {
    return { ok: false, facts: f, reason: `This browser can't decode this video's sound (${codecName(f.audio.codec)}). ` +
      "Export it with AAC sound (the usual setting for MP4) and upload that." };
  }
  if (f.duration < LIMITS.minSeconds) return { ok: false, facts: f, reason: "This video is too short to have a voiceover." };
  if (f.duration > LIMITS.maxSeconds) {
    return { ok: false, facts: f, reason: `This video is ${clock(f.duration)} long. The app is made for short videos, up to ` +
      `${LIMITS.maxSeconds / 60} minutes: cut it into parts and upload each.` };
  }
  const long = Math.max(v.width, v.height), short = Math.min(v.width, v.height);
  if (long > LIMITS.maxSide) return { ok: false, facts: f, reason: `This video is ${v.width}×${v.height}, bigger than 8K. Export it at 4K or less.` };
  if (short < LIMITS.minSide) return { ok: false, facts: f, reason: `This video is only ${v.width}×${v.height} pixels. Upload a bigger version.` };
  if (v.fps > LIMITS.maxFps) {
    return { ok: false, facts: f, reason: `This video has ${rate(v.fps)} frames a second (slow motion?). Export it at 60 fps or less.` };
  }

  const notes: string[] = [];
  if (v.rotation) notes.push(`It's recorded turned by ${v.rotation}° and will be shown upright, as ${v.width}×${v.height}.`);
  if (v.variable) notes.push(`Its frame rate varies; the translated videos are made at a steady ${rate(v.fps)} frames a second.`);
  if (v.width % 2 || v.height % 2) notes.push(`Its size is odd (${v.width}×${v.height}); the translated videos are one pixel smaller, as video encoders need even sizes.`);
  const summary = `${v.width}×${v.height} · ${clock(f.duration)} · ${rate(v.fps)} fps · ${codecName(v.codec)} with ${codecName(f.audio.codec)} sound`;
  return { ok: true, summary, notes, facts: f };
}

/** Check a picked file (or, on the job page, the uploaded one by its link). */
export async function checkVideo(source: Blob | string): Promise<Check> {
  const problem = browserProblem();
  if (problem) return { ok: false, reason: problem, facts: null };
  let input: Input | null = null;
  try {
    input = openInput(source);
    let facts: VideoFacts;
    try {
      facts = await readFacts(input);
    } catch {
      return { ok: false, facts: null, reason: "This file can't be read as a video. Choose an .mp4 or .mov file (the finished video)." };
    }
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const can = { video: v ? await v.canDecode().catch(() => false) : false, audio: a ? await a.canDecode().catch(() => false) : false };
    return judge(facts, can);
  } finally {
    input?.dispose();
  }
}

/** Whether this browser can encode the voiceover as AAC (else it is sent as WAV, which is bigger but as good). */
export const canEncodeVoiceover = (sampleRate: number) => canEncodeAudio("aac", { numberOfChannels: 1, sampleRate, bitrate: 128_000 }).catch(() => false);
