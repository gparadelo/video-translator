import Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { prepareStep } from "@/lib/prepare/server";
import { namesStep } from "@/lib/prepare/steps";

// One Claude call (a short transcript: usually seconds).
export const maxDuration = 300;

// POST /api/jobs/<id>/prepare/names {runner}
//   Claude checks the spelling of names in the transcript, with the project's "Names in the video" as reference
//   (vt.fix_names), or returns the saved result
// -> {changed, refused, cached}. Errors: {error, retry?, after?, code?}. See lib/prepare/steps.ts.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/prepare/names">) {
  return prepareStep(request, ctx.params, ["preparing"], "anthropic", ({ job, key }) => {
    // no retries inside: the page retries (with backoff), so this call stays one Claude call long
    const claude = new Anthropic({ apiKey: key, maxRetries: 0, timeout: (maxDuration - 15) * 1000 });
    return namesStep(job, claude);
  });
}
