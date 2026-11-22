import { NextResponse, type NextRequest } from "next/server";
import { fail, generationOf, outputKey } from "@/lib/api";
import { objectSize, uploadUrl } from "@/lib/r2";
import { getUser } from "@/lib/supabase/server";

const MAX_PREVIEW_BYTES = 500_000_000; // a 720p preview of a short video is a few tens of MB

// The browser renders a 720p preview of a language and keeps it in storage, so it plays on the job page.
//   POST /api/jobs/<id>/preview/<lang> {generation, bytes}           -> {upload: {url, headers}}: PUT the MP4 there
//   POST /api/jobs/<id>/preview/<lang> {generation, bytes, done: true} -> checks it arrived whole, then saves it
// Until the second call the page doesn't know about the file, so an upload that broke off leaves nothing half-done.
// `generation` is the run of the language the preview was made from (job_outputs.generation): the file goes in
// that run's folder, and is only saved while the language is still at that run.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/preview/[lang]">) {
  const { id, lang } = await ctx.params;
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const body = await request.json().catch(() => null);
  const bytes = Number(body?.bytes);
  if (!Number.isInteger(bytes) || bytes < 1) return fail(400, "say how big the preview is (bytes)");
  if (bytes > MAX_PREVIEW_BYTES) return fail(413, "the preview is too big");
  const generation = generationOf(body?.generation);
  if (generation === null) return fail(400, "say which run of this language the preview is for (generation)");

  const { data: out } = await supabase
    .from("job_outputs")
    .select("status, user_id, generation")
    .eq("job_id", id)
    .eq("lang", lang)
    .maybeSingle();
  if (!out || out.status !== "ready") return fail(404, "this language isn't ready to render");
  if (out.generation !== generation) return fail(409, "this language changed while its preview was being made");
  const key = outputKey(out.user_id, id, lang, generation, "preview.mp4");

  if (!body?.done) {
    return NextResponse.json({
      upload: { url: await uploadUrl(key, bytes, "video/mp4"), headers: { "Content-Type": "video/mp4" } },
    });
  }

  const size = await objectSize(key);
  if (size !== bytes) return fail(409, "the preview didn't upload completely - make it again");
  const { error } = await supabase.rpc("save_preview", { p_job: id, p_lang: lang, p_generation: generation, p_bytes: bytes });
  if (error) return fail(500, error.message);
  return NextResponse.json({ ok: true });
}
