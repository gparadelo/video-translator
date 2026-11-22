import type { NextRequest } from "next/server";
import { moveOn, prepareStep } from "@/lib/prepare/server";
import { alignStep } from "@/lib/prepare/steps";

// One ElevenLabs forced alignment call, then the analysis (milliseconds).
export const maxDuration = 300;

// POST /api/jobs/<id>/prepare/align {runner}
//   preparing: times every word of the checked transcript, ties every cut to a word, writes analysis.json and hands
//              the transcript to the person (save_prepared) -> {status: "needs_review", warnings}
//   aligning:  the same for the approved (edited) transcript; then the job page translates it (save_aligned), or,
//              when the edits broke the timing, it goes back to the review -> {status: "producing" | "needs_review"}
// Errors: {error, retry?, after?, code?}. See lib/prepare/steps.ts.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/prepare/align">) {
  return prepareStep(request, ctx.params, ["preparing", "aligning"], "elevenlabs", ({ job, key, supabase }) =>
    alignStep(job, { apiKey: key }, {
      prepared: (p) => moveOn(supabase, "save_prepared", {
        p_job: job.jobId, p_base_lang: p.baseLang, p_script: p.script, p_names_fixed: p.namesFixed, p_warnings: p.warnings,
      }),
      aligned: (a) => moveOn(supabase, "save_aligned", { p_job: job.jobId, p_script: a.script, p_warnings: a.warnings, p_ok: a.ok }),
    }));
}
