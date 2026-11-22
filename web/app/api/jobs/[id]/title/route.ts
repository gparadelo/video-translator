import { NextResponse, type NextRequest } from "next/server";
import { fail } from "@/lib/api";
import { LANGS } from "@/lib/jobs";
import { getUser } from "@/lib/supabase/server";
import { TitleError, translateTitle } from "@/lib/translate-title";

export const maxDuration = 60;

// POST /api/jobs/<id>/title  {title?, source?: "auto" | "<code>", missing?: boolean}
// Translates the project's title into the project's languages and saves it on the project.
//   title + source: set (or change) the title, and translate it into every language again.
//   missing: true:  keep the title and the translations there are; translate only the languages without one.
// -> {job}
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/title">) {
  const { id } = await ctx.params;
  const { supabase, user } = await getUser();
  if (!user) return fail(401, "sign in first");

  const { data: job } = await supabase.from("jobs").select().eq("id", id).maybeSingle();
  if (!job) return fail(404, "project not found");

  const body = await request.json().catch(() => null);
  const missing = body?.missing === true;
  const typed = typeof body?.title === "string" ? body.title.trim() : "";
  if (typed.length > 300) return fail(400, "the title is too long (300 characters at most)");
  const title: string = missing ? (job.title ?? "") : typed || (job.title ?? "");
  if (!title) return fail(400, "type a title first");

  // A new title starts over; the same title keeps its known language unless the person picked another.
  const changed = !missing && title !== job.title;
  const picked = typeof body?.source === "string" && body.source in LANGS ? body.source : null;
  const given: string | null = picked ?? (body?.source === "auto" || changed ? null : job.title_lang);

  const have: Record<string, string> = job.titles ?? {};
  const targets: string[] = missing ? job.languages.filter((l: string) => !have[l]) : job.languages;
  if (missing && !targets.length) return NextResponse.json({ job });

  try {
    const t = await translateTitle(title, given, targets);
    const { data, error } = await supabase.rpc("set_titles", {
      p_job: id,
      p_title: title,
      p_title_lang: t.source,
      p_titles: { ...t.titles, [t.source]: missing ? (have[t.source] ?? t.original) : t.original },
      p_replace: !missing,
    });
    if (error) return fail(500, error.message);
    return NextResponse.json({ job: data });
  } catch (err) {
    if (err instanceof TitleError) return fail(err.status, err.message);
    return fail(500, (err as Error).message);
  }
}
