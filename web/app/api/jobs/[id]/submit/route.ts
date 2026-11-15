import { NextResponse, type NextRequest } from "next/server";
import { fail } from "@/lib/api";
import { objectSize } from "@/lib/r2";
import { getUser } from "@/lib/supabase/server";

// POST /api/jobs/<id>/submit: the browser finished uploading. Checks the video really is in storage,
// then puts the job in the queue for the worker.
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/submit">) {
  const { id } = await ctx.params;
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const { data: job } = await supabase.from("jobs").select().eq("id", id).maybeSingle();
  if (!job) return fail(404, "job not found");
  if (job.status !== "uploading") return NextResponse.json({ job }); // already submitted

  const size = await objectSize(job.source_key);
  if (size === null) return fail(409, "the video hasn't been uploaded yet");
  if (size !== Number(job.source_bytes)) return fail(409, "the upload is incomplete - upload the video again");

  const { data, error } = await supabase.rpc("submit_job", { p_job: id });
  if (error) return fail(500, error.message);
  return NextResponse.json({ job: data });
}
