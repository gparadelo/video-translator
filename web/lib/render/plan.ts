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
  return p as RenderPlan;
}
