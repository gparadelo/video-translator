// plan.json as the worker stores it in R2 (vt.portable_plan): how to cut and retime the source for one language.
// See "Files in storage" in docs/web-setup.md.

import type { Segment } from "./frames";

export const PLAN_FORMAT = 1;

export type RenderPlan = {
  format: number;
  lang: string;
  /** The source's frame rate (ffprobe r_frame_rate as a float); the output has the same rate. */
  fps: number;
  total_frames: number;
  segments: (Segment & { seg: number; out_start: number; base_len: number; trimmed: number })[];
  /** The source's displayed size (rotation applied), as ffmpeg decodes it. */
  source: { width: number; height: number };
  /** The finished voice track next to plan.json: PCM WAV, exactly total_frames / fps long. */
  voice: { file: string; sample_rate: number; channels: number };
  flags: { msg: string }[];
};

/** Check a downloaded plan.json and return it typed; throws a readable error when it can't be rendered. */
export function parsePlan(json: unknown): RenderPlan {
  const p = json as Partial<RenderPlan> | null;
  if (!p || typeof p !== "object") throw new Error("the plan is not readable");
  if (p.format !== PLAN_FORMAT) throw new Error(`this plan has format ${p.format ?? "none"}, expected ${PLAN_FORMAT}: translate this language again`);
  if (!(typeof p.fps === "number" && p.fps > 0)) throw new Error("the plan has no frame rate");
  if (!Array.isArray(p.segments) || !p.segments.length) throw new Error("the plan has no clips");
  let sum = 0;
  for (const s of p.segments) {
    if (!(s.frames > 0) || !(s.speed > 0) || !(s.src_start >= 0) || !(s.src_len > 0)) throw new Error(`clip ${s.seg} of the plan is invalid`);
    sum += s.frames;
  }
  if (sum !== p.total_frames) throw new Error("the plan's clips don't add up to its length");
  const { width, height } = p.source ?? {};
  if (!(Number.isInteger(width) && width! > 0 && Number.isInteger(height) && height! > 0)) throw new Error("the plan has no video size");
  if (!(p.voice && p.voice.sample_rate > 0 && p.voice.channels > 0)) throw new Error("the plan doesn't describe its voice track");
  return p as RenderPlan;
}

/**
 * The size to render at, before rounding to even numbers: the source's size as the worker's ffmpeg sees it
 * (plan.source), like the CLI render. `displayW` x `displayH` is the size this browser shows the source at;
 * when its shape disagrees with the plan's (portrait here, landscape there), the rotation was read
 * differently, and the video would come out sideways or squashed.
 */
export function sourceSize(plan: RenderPlan, displayW: number, displayH: number): [number, number] {
  const { width, height } = plan.source;
  const shape = (w: number, h: number) => Math.sign(w - h);
  if (shape(width, height) * shape(displayW, displayH) < 0)
    throw new Error("this browser reads the video's rotation differently from the worker Mac, so it can't make this video");
  return [width, height];
}

/** Check the voice track fits the plan: the format it was made in, and as long as the video (within a frame). */
export function checkVoice(plan: RenderPlan, voice: { sampleRate: number; channels: number; frames: number }) {
  if (voice.sampleRate !== plan.voice.sample_rate || voice.channels !== plan.voice.channels)
    throw new Error(`the voice track is ${voice.sampleRate} Hz with ${voice.channels} channels, not what the plan says`);
  const want = (plan.total_frames / plan.fps) * voice.sampleRate;
  if (Math.abs(voice.frames - want) > voice.sampleRate / plan.fps)
    throw new Error("the voice track isn't as long as the video: translate this language again");
}
