import { NextResponse, type NextRequest } from "next/server";
import { fail } from "@/lib/api";
import { downloadUrl } from "@/lib/r2";
import { getUser } from "@/lib/supabase/server";

// GET /api/jobs/<id>/files/<lang>            -> redirects to the full-size video (source resolution), as a download
// GET /api/jobs/<id>/files/<lang>?kind=preview -> redirects to the small copy, to play in the page
// The redirect target is a signed link that works for one hour.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/files/[lang]">) {
  const { id, lang } = await ctx.params;
  const preview = request.nextUrl.searchParams.get("kind") === "preview";
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  // Row-level security only returns the person's own outputs.
  const { data: out } = await supabase
    .from("job_outputs")
    .select("output_key, preview_key, jobs(name)")
    .eq("job_id", id)
    .eq("lang", lang)
    .maybeSingle();
  const key = preview ? out?.preview_key : out?.output_key;
  if (!key) return fail(404, "this video isn't ready (or was removed)");

  const jobName = (out?.jobs as { name?: string } | null)?.name ?? "video";
  return NextResponse.redirect(await downloadUrl(key, preview ? undefined : `${jobName}_${lang}.mp4`));
}
