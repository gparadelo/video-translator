import { NextResponse, type NextRequest } from "next/server";
import { fail } from "@/lib/api";
import { downloadUrl } from "@/lib/r2";
import { getUser } from "@/lib/supabase/server";

// GET /api/jobs/<id>/render/<lang> -> {name, source, plan, voice}: signed links (6 hours) to everything the
// browser needs to render this language: the uploaded video (read in pieces with range requests), the
// plan (plan.json) and the finished voice track (voice.wav). See "Files in storage" in docs/web-setup.md.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/render/[lang]">) {
  const { id, lang } = await ctx.params;
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  // Row-level security only returns the person's own rows.
  const { data: out } = await supabase
    .from("job_outputs")
    .select("status, plan_key, voice_key, jobs(name, source_key)")
    .eq("job_id", id)
    .eq("lang", lang)
    .maybeSingle();
  const job = out?.jobs as { name?: string; source_key?: string } | null;
  if (!out || out.status !== "ready" || !out.plan_key || !out.voice_key || !job?.source_key)
    return fail(404, "this language isn't ready to render");

  const hours6 = 6 * 60 * 60; // long enough for a slow 4K render
  const [source, plan, voice] = await Promise.all([
    downloadUrl(job.source_key, undefined, hours6),
    downloadUrl(out.plan_key, undefined, hours6),
    downloadUrl(out.voice_key, undefined, hours6),
  ]);
  return NextResponse.json({ name: job.name ?? "video", source, plan, voice });
}
