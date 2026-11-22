import Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { CLAUDE } from "@/lib/produce/config";
import { ProduceError } from "@/lib/produce/errors";
import { intIn, produceStep } from "@/lib/produce/server";
import { translateStep } from "@/lib/produce/steps";

// One Claude call: a long script can take a minute or two. 300 s is the most Vercel allows on every plan with
// Fluid compute (on by default); without it the Hobby plan stops a function after 60 s.
export const maxDuration = 300;

// POST /api/jobs/<id>/produce/<lang>/translate
//   {generation, kind: "translate"}         -> the translation (made now, or the saved one)
//   {generation, kind: "rewrite", round}    -> Claude rewrites the beats the plan of that round flagged
// -> {done: true, round, beats} | {done: false, problems, attempt}: ask again for Claude's next try.
// Errors: {error, retry?, after?, code?} (lib/produce/errors.ts). See lib/produce/steps.ts.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/produce/[lang]/translate">) {
  return produceStep(request, ctx.params, "anthropic", ({ run, key }, body) => {
    const kind = body.kind === "rewrite" ? "rewrite" : body.kind === "translate" ? "translate" : null;
    if (!kind) throw new ProduceError("say what to do (kind: translate or rewrite)", { status: 400 });
    const round = kind === "rewrite" ? intIn(body.round, 0, CLAUDE.fix_rounds, "the round") : undefined;
    // no retries inside: the page retries (with backoff), so this call stays one Claude call long
    const claude = new Anthropic({ apiKey: key, maxRetries: 0, timeout: (maxDuration - 15) * 1000 });
    return translateStep(run, claude, { kind, round });
  });
}
