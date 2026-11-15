import { NextResponse, type NextRequest } from "next/server";
import { extension, fail, VIDEO_TYPES } from "@/lib/api";
import { uploadUrl } from "@/lib/r2";
import { getUser } from "@/lib/supabase/server";

// POST /api/jobs/<id>/upload-url: a fresh upload link for a job that is still waiting for its video
// (the first upload failed or its link expired).
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/upload-url">) {
  const { id } = await ctx.params;
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const { data: job } = await supabase.from("jobs").select().eq("id", id).maybeSingle();
  if (!job) return fail(404, "job not found");
  if (job.status !== "uploading") return fail(409, "this job already has its video");

  const contentType = VIDEO_TYPES[extension(job.source_filename ?? "")] ?? "video/mp4";
  return NextResponse.json({
    upload: { url: await uploadUrl(job.source_key, job.source_bytes, contentType), headers: { "Content-Type": contentType } },
  });
}
