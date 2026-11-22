import { NextResponse, type NextRequest } from "next/server";
import { fail, generationOf, outputKey } from "@/lib/api";
import { CHANNELS, SAMPLE_RATE } from "@/lib/pipeline/config";
import { CLIP_FILE, metaFile, parseInputs } from "@/lib/pipeline/inputs";
import { writeReport, type Plan } from "@/lib/pipeline/plan";
import { pyFormat } from "@/lib/pipeline/py";
import { parsePlan } from "@/lib/render/plan";
import { downloadUrl, objectSize, readText, uploadUrl } from "@/lib/r2";
import { getUser } from "@/lib/supabase/server";

// A voiced language: the browser builds its timing plan and voice track (lib/pipeline/run.ts).
//   GET  /api/jobs/<id>/plan/<lang> -> {generation, inputs, clips: {<file>: {audio, timing}}}: signed links (1 hour)
//        to the plan inputs of the run the language is at (inputs.json and every TTS clip it names)
//   POST /api/jobs/<id>/plan/<lang> {generation, plan_bytes, voice_bytes} -> {plan: {url, headers}, voice: {...}}:
//        PUT plan.json and voice.wav there (the run's own folder)
//   POST ... {generation, plan_bytes, voice_bytes, done: true} -> checks both arrived whole, reads the plan (its
//        length and flags, and the report written from it, go on the row) and marks the language ready
// The keys are made here and in the database from the row, never taken from the browser.

const MAX_PLAN_BYTES = 5_000_000;
const MAX_VOICE_BYTES = 400_000_000; // 16-bit stereo 44.1 kHz: about 10 MB a minute

async function row(id: string, lang: string) {
  const { supabase, user } = await getUser();
  if (!user) return { error: fail(401, "sign in first") } as const;
  // Row-level security only returns the person's own rows.
  const { data: out } = await supabase
    .from("job_outputs")
    .select("status, user_id, generation, inputs_key, jobs(name)")
    .eq("job_id", id)
    .eq("lang", lang)
    .maybeSingle();
  if (!out || out.status !== "voiced" || !out.inputs_key)
    return { error: fail(404, "this language isn't waiting for its voice track") } as const;
  return { supabase, out, name: (out.jobs as { name?: string } | null)?.name ?? "video" } as const;
}

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/plan/[lang]">) {
  const { id, lang } = await ctx.params;
  const r = await row(id, lang);
  if ("error" in r) return r.error;
  const { out } = r;
  const text = await readText(out.inputs_key!);
  if (text === null) return fail(410, "the recorded voice for this language was removed (files are kept for 30 days): translate it again");
  let files: string[];
  try {
    files = parseInputs(JSON.parse(text)).clips.map((c) => c.file);
  } catch (e) {
    return fail(422, (e as Error).message);
  }
  const key = (file: string) => outputKey(out.user_id, id, lang, out.generation, file);
  const clips: Record<string, { audio: string; timing: string }> = {};
  await Promise.all(files.filter((f) => CLIP_FILE.test(f)).map(async (f) => {
    const [audio, timing] = await Promise.all([downloadUrl(key(`tts/${f}`)), downloadUrl(key(`tts/${metaFile(f)}`))]);
    clips[f] = { audio, timing };
  }));
  return NextResponse.json({ generation: out.generation, inputs: await downloadUrl(out.inputs_key!), clips });
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/plan/[lang]">) {
  const { id, lang } = await ctx.params;
  const body = await request.json().catch(() => null);
  const generation = generationOf(body?.generation);
  const planBytes = Number(body?.plan_bytes), voiceBytes = Number(body?.voice_bytes);
  if (generation === null) return fail(400, "say which run of this language this is for (generation)");
  if (!Number.isInteger(planBytes) || planBytes < 1 || !Number.isInteger(voiceBytes) || voiceBytes < 45)
    return fail(400, "say how big plan.json and voice.wav are (plan_bytes, voice_bytes)");
  if (planBytes > MAX_PLAN_BYTES || voiceBytes > MAX_VOICE_BYTES) return fail(413, "the plan or the voice track is too big");

  const r = await row(id, lang);
  if ("error" in r) return r.error;
  const { supabase, out, name } = r;
  if (out.generation !== generation) return fail(409, "this language changed while its voice was being prepared");
  const planKey = outputKey(out.user_id, id, lang, generation, "plan.json");
  const voiceKey = outputKey(out.user_id, id, lang, generation, "voice.wav");

  if (!body?.done) {
    const [plan, voice] = await Promise.all([
      uploadUrl(planKey, planBytes, "application/json"),
      uploadUrl(voiceKey, voiceBytes, "audio/wav"),
    ]);
    return NextResponse.json({
      plan: { url: plan, headers: { "Content-Type": "application/json" } },
      voice: { url: voice, headers: { "Content-Type": "audio/wav" } },
    });
  }

  const [ps, vs] = await Promise.all([objectSize(planKey), objectSize(voiceKey)]);
  if (ps !== planBytes || vs !== voiceBytes) return fail(409, "the voice track didn't upload completely - prepare it again");
  let plan: Plan & ReturnType<typeof parsePlan>;
  try {
    plan = parsePlan(JSON.parse((await readText(planKey, MAX_PLAN_BYTES)) ?? "null")) as Plan & ReturnType<typeof parsePlan>;
  } catch (e) {
    return fail(422, `the plan can't be used: ${(e as Error).message}`);
  }
  // voice.wav is a 44-byte header and 16-bit samples: it must be as long as the video (within a frame), in the
  // format the plan names, or the language would be ready but couldn't be rendered
  const { sample_rate: rate, channels } = plan.voice;
  const frames = (voiceBytes - 44) / (2 * channels);
  if (rate !== SAMPLE_RATE || channels !== CHANNELS || Math.abs(frames - (plan.total_frames / plan.fps) * rate) > rate / plan.fps)
    return fail(422, "the voice track doesn't fit the plan - prepare it again");
  const seconds = Number(pyFormat(plan.total_frames / plan.fps, 2)); // vt.produce: round(seconds, 2)
  const flags = (Array.isArray(plan.flags) ? plan.flags : []).slice(0, 100).map((f) => String(f?.msg ?? "").slice(0, 500));
  let report: string | null = null;
  try {
    report = writeReport(name, plan);
  } catch {
    // the report is only for reading; a plan the renderer accepts is enough
  }
  const { error } = await supabase.rpc("save_plan", {
    p_job: id, p_lang: lang, p_generation: generation, p_seconds: seconds, p_flags: flags, p_report: report,
  });
  if (error) return fail(409, error.message);
  return NextResponse.json({ ok: true, seconds, flags });
}
