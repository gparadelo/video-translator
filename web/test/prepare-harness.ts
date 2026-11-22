// The prepare routes without Next.js, Supabase or R2, for test/e2e: the same steps (lib/prepare/steps.ts) behind
// the paths the job page's code (lib/prepare/run.ts) calls, over a folder store, with the project's row kept in
// memory and moved on the way the database functions do (save_prepared, save_aligned, approve_job). Signed links
// point back at the test server: PUT /upload/<key> writes into the store, GET /files/store/<key> reads from it.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProduceError } from "../lib/produce/errors";
import { alignStep, analysisKey, mediaStep, namesStep, transcribeStep, type Links, type MediaRequest, type PrepJob } from "../lib/prepare/steps";
import { folderStore } from "./produce-harness";

export type Row = {
  status: "uploading" | "preparing" | "needs_review" | "aligning" | "producing";
  base_lang: string | null;
  script: string | null;
  analysis_script: string | null;
  analysis_key: string | null;
  reference: string | null;
  warnings: string[];
  names_fixed: string[];
  runner: string | null;
};

export function prepareBackend(o: { root: string; userId: string; jobId: string; reference: string | null; claudeUrl: string; elevenUrl: string }) {
  const store = folderStore(o.root);
  const row: Row = { status: "uploading", base_lang: null, script: null, analysis_script: null, analysis_key: null,
                     reference: o.reference, warnings: [], names_fixed: [], runner: null };
  const links: Links = {
    put: async (key) => `/upload/${key}`,
    get: async (key) => `/files/store/${key}`,
    size: async (key) => (existsSync(join(o.root, key)) ? statSync(join(o.root, key)).size : null),
  };
  const claude = new Anthropic({ apiKey: "fake-claude-key", baseURL: o.claudeUrl, maxRetries: 0 });
  const eleven = { apiKey: "fake-eleven-key", api: o.elevenUrl };
  const calls: string[] = [];

  const job = (): PrepJob => ({
    store, userId: o.userId, jobId: o.jobId, status: row.status as PrepJob["status"], baseLang: row.base_lang, script: row.script,
    reference: row.reference, warnings: row.warnings, analysisKey: row.analysis_key,
  });

  /** One prepare route call, answered like the route does. */
  async function handle(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const m = /\/prepare\/(media|transcribe|names|align)$/.exec(path);
    if (!m) return { status: 404, json: { error: "no such route" } };
    const step = m[1];
    calls.push(step);
    try {
      const allowed = step === "media" || step === "align" ? ["preparing", "aligning"] : ["preparing"];
      if (!allowed.includes(row.status)) throw new ProduceError("this project moved on", { status: 409, code: "gone" });
      if (body.runner !== row.runner) throw new ProduceError("another browser is preparing this video", { status: 409, code: "taken" });
      const j = job();
      const out = step === "media" ? await mediaStep(j, links, body as unknown as MediaRequest)
        : step === "transcribe" ? await transcribeStep(j, eleven)
          : step === "names" ? await namesStep(j, claude)
            : await alignStep(j, eleven, {
              prepared: async (p) => void Object.assign(row, { status: "needs_review", base_lang: p.baseLang, script: p.script, analysis_script: p.script,
                                                              analysis_key: analysisKey(j), names_fixed: p.namesFixed, warnings: p.warnings, runner: null }),
              aligned: async (a) => void Object.assign(row, { status: a.ok ? "producing" : "needs_review", script: a.script, analysis_script: a.script,
                                                             analysis_key: analysisKey(j), warnings: a.warnings, runner: null }),
            });
      return { status: 200, json: out };
    } catch (e) {
      const err = e instanceof ProduceError ? e : new ProduceError(`something went wrong on the server: ${(e as Error).message}`, { status: 500, retry: true });
      return { status: err.status, json: err.toJSON() };
    }
  }

  return {
    row, store, calls, handle,
    /** submit_job + hold_prepare */
    submit(runner: string) {
      Object.assign(row, { status: "preparing", runner });
    },
    /** approve_job: unchanged -> producing, edited -> aligning (held by `runner`) */
    approve(script: string | null, runner: string) {
      const next = script ?? row.script;
      Object.assign(row, { script: next, status: row.analysis_key && next === row.analysis_script ? "producing" : "aligning", runner });
    },
  };
}
