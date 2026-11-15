import { NextResponse, type NextRequest } from "next/server";
import { extension, fail, MAX_BYTES, VIDEO_TYPES } from "@/lib/api";
import { uploadUrl } from "@/lib/r2";
import { getUser } from "@/lib/supabase/server";

// POST /api/jobs  {name, filename, bytes, languages, reference?}
// Creates the job (status "uploading") and returns a link the browser uploads the video to:
//   PUT upload.url with upload.headers and the file as the body, then POST /api/jobs/<id>/submit.
export async function POST(request: NextRequest) {
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  const filename = typeof body?.filename === "string" ? body.filename : "";
  const bytes = Number(body?.bytes);
  const languages: unknown = body?.languages;
  const contentType = VIDEO_TYPES[extension(filename)];

  if (!name) return fail(400, "the video needs a name");
  if (!contentType) return fail(400, "the video must be an .mp4, .mov or .m4v file");
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) return fail(400, "the video must be under 5 GB");
  if (!Array.isArray(languages) || !languages.length || !languages.every((l) => /^[a-z]{2}$/.test(String(l))))
    return fail(400, "choose at least one language (2-letter codes)");

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      name,
      source_filename: filename.slice(0, 200),
      source_bytes: bytes,
      languages,
      reference: typeof body?.reference === "string" && body.reference.trim() ? body.reference.slice(0, 20000) : null,
    })
    .select()
    .single();
  if (error) {
    // 42501: row-level security said no, i.e. this account hasn't been approved yet.
    return error.code === "42501" ? fail(403, "your account isn't approved yet") : fail(500, error.message);
  }

  return NextResponse.json({
    job,
    upload: { url: await uploadUrl(job.source_key, bytes, contentType), headers: { "Content-Type": contentType } },
  });
}
