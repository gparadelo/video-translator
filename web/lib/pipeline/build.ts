// Plan inputs -> plan.json + voice.wav for one language. Pure (the caller fetches and decodes): the job page
// runs it in the browser (run.ts), the parity tests in Node.

import { CHANNELS, SAMPLE_RATE } from "./config";
import type { ClipMeta, PlanInputs } from "./inputs";
import { buildPlan, portablePlan, type Plan, type PortablePlan } from "./plan";
import { buildVoice, encodeWav } from "./voice";

/**
 * A clip's length in seconds as the old Python pipeline sees it (ffprobe's format duration): the decoded samples (MP3 encoder
 * delay and padding removed, which the browser's decoder does as ffmpeg does), in whole microseconds.
 */
export function clipDuration(samples: number, sampleRate = SAMPLE_RATE): number {
  const us = Math.floor((samples * 1_000_000 + sampleRate / 2) / sampleRate); // av_rescale: nearest, halves up
  return Number(`${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, "0")}`);
}

export type DecodedClip = { meta: ClipMeta; samples: Float32Array; sampleRate: number };

export type Built = { plan: Plan; portable: PortablePlan; voice: ArrayBuffer; seconds: number };

export function buildLanguage(inputs: PlanInputs, clips: DecodedClip[]): Built {
  clips.forEach((c, i) => {
    if (c.sampleRate !== SAMPLE_RATE) throw new Error(`beat ${inputs.script[i].id}'s voice is ${c.sampleRate} Hz, not ${SAMPLE_RATE}`);
  });
  const plan = buildPlan(inputs, clips.map((c) => ({ meta: c.meta, duration: clipDuration(c.samples.length, c.sampleRate) })));
  const portable = portablePlan(plan, inputs.analysis.source);
  const v = buildVoice(plan.beats, clips.map((c) => c.samples), plan.total_frames, plan.fps, inputs.analysis.base_lufs);
  return { plan, portable, voice: encodeWav(v.data, SAMPLE_RATE, CHANNELS), seconds: plan.total_frames / plan.fps };
}
