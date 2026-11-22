import type { NextRequest } from "next/server";
import { CLAUDE } from "@/lib/produce/config";
import { intIn, produceStep } from "@/lib/produce/server";
import { ttsStep } from "@/lib/produce/steps";

// One ElevenLabs call for one beat (a few seconds; the call itself gives up after 50 s).
export const maxDuration = 60;

// POST /api/jobs/<id>/produce/<lang>/tts {generation, round, beat}
//   voices beat number `beat` (0-based) of the translation at `round`, or reuses the clip when it was voiced before
// -> {beat, file, cached, duration}. Errors: {error, retry?, after?, code?}. See lib/produce/steps.ts.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/produce/[lang]/tts">) {
  return produceStep(request, ctx.params, "elevenlabs", ({ run, key }, body) =>
    ttsStep(run, { apiKey: key }, {
      round: intIn(body.round, 0, CLAUDE.fix_rounds, "the round"),
      beat: intIn(body.beat, 0, 499, "the beat"),
    }));
}
