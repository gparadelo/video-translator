import type { NextRequest } from "next/server";
import { CLAUDE } from "@/lib/produce/config";
import { ProduceError } from "@/lib/produce/errors";
import { intIn, produceStep } from "@/lib/produce/server";
import { fitStep } from "@/lib/produce/steps";

// Reads the run's clips back from storage and builds the timing plan: a few seconds.
export const maxDuration = 60;

// POST /api/jobs/<id>/produce/<lang>/fit {generation, round}
//   the timing plan of the translation at `round` from its recorded beats. Nothing flagged, or the last round:
//   writes the plan inputs (inputs.json) and marks the language voiced (then the page builds the plan and the
//   voice track, as for any voiced language). Otherwise the beats to rewrite are flagged.
// -> {voiced, round, flags}. Errors: {error, retry?, after?, code?}. See lib/produce/steps.ts.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/produce/[lang]/fit">) {
  return produceStep(request, ctx.params, null, ({ run, supabase }, body) =>
    fitStep(run, { round: intIn(body.round, 0, CLAUDE.fix_rounds, "the round") }, async () => {
      const { error } = await supabase.rpc("mark_voiced", { p_job: run.jobId, p_lang: run.lang, p_generation: run.generation });
      if (error) throw new ProduceError(error.message, { status: 409, code: "gone" });
    }));
}
