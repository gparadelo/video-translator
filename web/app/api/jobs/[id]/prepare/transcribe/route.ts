import type { NextRequest } from "next/server";
import { prepareStep } from "@/lib/prepare/server";
import { transcribeStep } from "@/lib/prepare/steps";

// One ElevenLabs speech-to-text call on the voiceover (read from storage here): for a few minutes of audio this
// can take a while. 300 s is the most Vercel allows on every plan with Fluid compute; the call gives up at 280 s.
export const maxDuration = 300;

// POST /api/jobs/<id>/prepare/transcribe {runner}
//   transcribes the voiceover the browser uploaded (prep/audio.*), or returns the saved transcript
// -> {words, language, cached}. Errors: {error, retry?, after?, code?}. See lib/prepare/steps.ts.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/prepare/transcribe">) {
  return prepareStep(request, ctx.params, ["preparing"], "elevenlabs", ({ job, key }) => transcribeStep(job, { apiKey: key }));
}
