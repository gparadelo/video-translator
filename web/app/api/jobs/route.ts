import { NextResponse, type NextRequest } from "next/server";
import { extension, fail, MAX_BYTES, VIDEO_TYPES } from "@/lib/api";
import { LANGS } from "@/lib/jobs";
import { uploadUrl } from "@/lib/r2";
import { listOf, missingFor, toStatus } from "@/lib/setup";
import { getUser } from "@/lib/supabase/server";

// POST /api/jobs  {name, languages, filename?, bytes?, reference?, title?, title_lang?}
// Creates a project. It has a video (filename + bytes), a title, or both.
// With a video: the job starts "uploading", and the answer has a link the browser uploads the video to:
//   PUT upload.url with upload.headers and the file as the body, then POST /api/jobs/<id>/submit.
// Title only: the job is "done" from the start (nothing for the render Mac to do) and upload is null.
// Either way the title is translated afterwards with POST /api/jobs/<id>/title.
export async function POST(request: NextRequest) {
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  const filename = typeof body?.filename === "string" ? body.filename : "";
  const bytes = Number(body?.bytes);
  const languages: unknown = body?.languages;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const titleLang = typeof body?.title_lang === "string" && body.title_lang in LANGS ? body.title_lang : null;
  const hasVideo = Boolean(filename);
  const contentType = VIDEO_TYPES[extension(filename)];

  if (!hasVideo && !title) return fail(400, "add a video, a title, or both");
  if (!name) return fail(400, "the project needs a name");
  if (title.length > 300) return fail(400, "the title is too long (300 characters at most)");
  if (hasVideo && !contentType) return fail(400, "the video must be an .mp4, .mov or .m4v file");
  if (hasVideo && (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES))
    return fail(400, "the video must be under 5 GB");
  if (!Array.isArray(languages) || !languages.length || !languages.every((l) => /^[a-z]{2}$/.test(String(l))))
    return fail(400, "choose at least one language (2-letter codes)");

  // Projects run on the person's own keys and voice: don't start one that can't finish.
  const { data: profile } = await supabase.from("profiles").select("approved").maybeSingle();
  if (!profile?.approved) return fail(403, "this account has been blocked from creating projects");
  const { data: setupRows, error: setupError } = await supabase.rpc("my_key_status");
  const setup = toStatus(setupRows);
  if (setupError || !setup) return fail(500, "couldn't check your Settings - try again");
  const missing = missingFor(setup, { video: hasVideo, title: Boolean(title) });
  if (missing.length) return fail(409, `first add ${listOf(missing)} in Settings`);

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      name,
      languages,
      has_video: hasVideo,
      status: hasVideo ? "uploading" : "done",
      title: title || null,
      title_lang: title ? titleLang : null,
      ...(hasVideo && {
        source_filename: filename.slice(0, 200),
        source_bytes: bytes,
        reference: typeof body?.reference === "string" && body.reference.trim() ? body.reference.slice(0, 20000) : null,
      }),
    })
    .select()
    .single();
  if (error) {
    // 42501: row-level security said no, i.e. this account has been blocked (profiles.approved = false).
    return error.code === "42501" ? fail(403, "this account has been blocked from creating projects") : fail(500, error.message);
  }

  return NextResponse.json({
    job,
    upload: hasVideo
      ? { url: await uploadUrl(job.source_key, bytes, contentType), headers: { "Content-Type": contentType } }
      : null,
  });
}
