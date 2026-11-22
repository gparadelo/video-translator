// The prepare routes' common part (app/api/jobs/<id>/prepare/...): who is asking, which project, the person's keys,
// and the answer. Like lib/produce/server.ts, with the project's own state: preparing (the browser analyzes a new
// video) or aligning (an approved, edited transcript is timed again). Server only.

import { NextResponse, type NextRequest } from "next/server";
import { downloadUrl, objectSize, uploadUrl } from "@/lib/r2";
import { myKeys, UnreadableKey, type KeyName } from "@/lib/secrets";
import { getUser } from "@/lib/supabase/server";
import { ProduceError } from "../produce/errors";
import { r2Store } from "../produce/server";
import type { Links, PrepJob } from "./steps";

// as Postgres writes a uuid (it would also match other spellings, which would put the files under other keys)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUNNER = /^[A-Za-z0-9-]{8,64}$/;
const MAX_BODY = 4096;

export const r2Links: Links = {
  put: (key, bytes, type) => uploadUrl(key, bytes, type),
  get: (key) => downloadUrl(key, undefined, 6 * 60 * 60),
  size: objectSize,
};

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

type Status = PrepJob["status"];

/**
 * The project a request is about: the person's own row (row-level security), in one of the states the step works
 * in. Anything else answers "gone": the page stops and shows where the project is now. And only for the browser
 * that holds it (hold_prepare): another one is answered "taken", before anything is paid for.
 */
async function loadJob(id: string, runner: string, statuses: Status[], need: KeyName | null) {
  const { supabase, user } = await getUser();
  if (!user) throw new ProduceError("sign in first", { status: 401 });
  if (!UUID.test(id)) throw new ProduceError("project not found", { status: 404, code: "gone" });
  const { data: row, error } = await supabase
    .from("jobs")
    .select("id, user_id, status, base_lang, script, reference, warnings, analysis_key, runner, has_video")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ProduceError("couldn't read the project - trying again", { retry: true });
  if (!row || !row.has_video) throw new ProduceError("project not found", { status: 404, code: "gone" });
  if (!statuses.includes(row.status)) throw new ProduceError("this project moved on", { status: 409, code: "gone" });
  if (row.runner !== runner) throw new ProduceError("another browser is preparing this video", { status: 409, code: "taken" });

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

  const job: PrepJob = {
    store: r2Store,
    userId: row.user_id as string,
    jobId: id,
    status: row.status as Status,
    baseLang: row.base_lang,
    script: row.script,
    reference: row.reference,
    warnings: row.warnings ?? [],
    analysisKey: row.analysis_key,
    logUsage: async (service, amounts) => {
      const { error: e } = await supabase.rpc("log_usage", { p_job: id, p_service: service, p_amounts: amounts });
      if (e) console.warn(`couldn't record usage for job ${id}: ${e.message}`);
    },
  };
  return { job, key, supabase };
}

type Handler<T> = (ctx: Awaited<ReturnType<typeof loadJob>>, body: Record<string, unknown>) => Promise<T>;

/** Run one prepare step for a POST to /api/jobs/<id>/prepare/<step>, and answer with its result or error. */
export async function prepareStep<T>(request: NextRequest, params: Promise<{ id: string }>, statuses: Status[], need: KeyName | null,
                                     handler: Handler<T>) {
  try {
    const { id } = await params;
    const b = await body(request);
    if (typeof b.runner !== "string" || !RUNNER.test(b.runner)) throw new ProduceError("the browser's id (runner) is missing", { status: 400 });
    const ctx = await loadJob(id, b.runner, statuses, need);
    return NextResponse.json(await handler(ctx, b));
  } catch (e) {
    const err = e instanceof ProduceError ? e
      : new ProduceError(`something went wrong on the server: ${(e as Error)?.message ?? e}`, { status: 500, retry: true });
    if (err.status >= 500) console.error("prepare step failed:", e);
    return NextResponse.json(err.toJSON(), { status: err.status });
  }
}

/** An RPC that moves the project on; its failure means the project changed under the request. */
export async function moveOn(supabase: Awaited<ReturnType<typeof getUser>>["supabase"], fn: string, args: Record<string, unknown>) {
  const { error } = await supabase.rpc(fn, args);
  if (error) throw new ProduceError(error.message, { status: 409, code: "gone" });
}
