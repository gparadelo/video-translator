// The produce routes' common part (app/api/jobs/<id>/produce/<lang>/...): who is asking, which run of which
// language, the person's keys, and the answer. Server only.

import { NextResponse, type NextRequest } from "next/server";
import { copyObject, deleteObject, objectSize, putObject, readBytes } from "@/lib/r2";
import { myKeys, UnreadableKey, type KeyName } from "@/lib/secrets";
import { getUser } from "@/lib/supabase/server";
import { ProduceError } from "./errors";
import type { Run, Store } from "./steps";

export const r2Store: Store = {
  get: readBytes,
  put: putObject,
  copy: copyObject,
  exists: async (key) => (await objectSize(key)) !== null,
  remove: deleteObject,
};

const LANG = /^[a-z]{2}$/;
const MAX_BODY = 4096;

/** The request's JSON body (small: a few numbers), or a ProduceError. */
async function body(request: NextRequest): Promise<Record<string, unknown>> {
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) throw new ProduceError("request too big", { status: 413 });
  try {
    const b = JSON.parse(text || "{}");
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch {
    // below
  }
  throw new ProduceError("the request isn't JSON", { status: 400 });
}

export const intIn = (x: unknown, lo: number, hi: number, what: string) => {
  if (!Number.isInteger(x) || (x as number) < lo || (x as number) > hi) throw new ProduceError(`${what} is missing or invalid`, { status: 400 });
  return x as number;
};

/**
 * The run a request is about: the person's own row (row-level security), for a job that is producing, a language
 * that is running at the generation the page asked for. Anything else answers "gone": the page stops and shows
 * where the language is now.
 */
async function loadRun(id: string, lang: string, generation: number, need: KeyName | null) {
  const { supabase, user } = await getUser();
  if (!user) throw new ProduceError("sign in first", { status: 401 });
  if (!LANG.test(lang)) throw new ProduceError("no such language", { status: 400 });
  const { data: row, error } = await supabase
    .from("job_outputs")
    .select("status, generation, user_id, jobs(status, voices, analysis_key)")
    .eq("job_id", id)
    .eq("lang", lang)
    .maybeSingle();
  if (error) throw new ProduceError("couldn't read the project - trying again", { retry: true });
  const job = row?.jobs as { status?: string; voices?: Record<string, string>; analysis_key?: string | null } | null;
  if (!row || !job) throw new ProduceError("project not found", { status: 404, code: "gone" });
  if (job.status !== "producing" || row.status !== "running" || row.generation !== generation) {
    throw new ProduceError("this language was stopped or started again", { status: 409, code: "gone" });
  }
  const voice = job.voices?.[lang];
  if (!voice) throw new ProduceError("this language has no voice: choose your ElevenLabs voice in Settings, then try again", { status: 409 });
  if (!job.analysis_key) throw new ProduceError("the video hasn't been analyzed: approve the transcript again", { status: 409 });

  let key = "";
  if (need) {
    let keys: Awaited<ReturnType<typeof myKeys>>;
    try {
      keys = await myKeys(supabase, user.id);
    } catch (e) {
      if (e instanceof UnreadableKey) throw new ProduceError(e.message, { status: 409 });
      throw new ProduceError((e as Error).message, { status: 500 });
    }
    key = keys[need] ?? "";
    if (!key) throw new ProduceError(`add your ${need === "elevenlabs" ? "ElevenLabs" : "Claude"} API key in Settings, then try again`, { status: 409 });
  }

  const run: Run = {
    store: r2Store,
    userId: row.user_id as string,
    jobId: id,
    lang,
    generation,
    voice,
    analysisKey: job.analysis_key,
    logUsage: async (service, amounts) => {
      const { error: e } = await supabase.rpc("log_usage", { p_job: id, p_service: service, p_amounts: amounts });
      if (e) console.warn(`couldn't record usage for job ${id}: ${e.message}`);
    },
  };
  return { run, key, supabase };
}

type Handler<T> = (ctx: Awaited<ReturnType<typeof loadRun>>, body: Record<string, unknown>) => Promise<T>;

/** Run one produce step for a POST to /api/jobs/<id>/produce/<lang>/<step>, and answer with its result or error. */
export async function produceStep<T>(request: NextRequest, params: Promise<{ id: string; lang: string }>, need: KeyName | null,
                                     handler: Handler<T>) {
  try {
    const { id, lang } = await params;
    const b = await body(request);
    const ctx = await loadRun(id, lang, intIn(b.generation, 1, 1_000_000, "the run (generation)"), need);
    return NextResponse.json(await handler(ctx, b));
  } catch (e) {
    const err = e instanceof ProduceError ? e
      : new ProduceError(`something went wrong on the server: ${(e as Error)?.message ?? e}`, { status: 500, retry: true });
    if (err.status >= 500) console.error("produce step failed:", e);
    return NextResponse.json(err.toJSON(), { status: err.status });
  }
}
