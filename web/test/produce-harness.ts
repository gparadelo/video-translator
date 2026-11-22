// The produce routes without Next.js, Supabase or R2, for the tests: the same steps (lib/produce/steps.ts) behind a
// fetch the job page's code (lib/produce/run.ts) can call, over a storage kept in memory or in a folder.
// test/produce-parity.test.ts uses it in Node; test/e2e serves it to Chrome from its test server.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProduceError } from "../lib/produce/errors";
import { fitStep, translateStep, ttsStep, type Run, type Store } from "../lib/produce/steps";
import type { ClaudeClient } from "../lib/produce/translate";

const enc = new TextEncoder();
const bytesOf = (b: Uint8Array | string) => (typeof b === "string" ? enc.encode(b) : b);

export function memoryStore(): Store & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async get(key, maxBytes) {
      const b = files.get(key);
      if (b && b.length > maxBytes) throw new Error(`${key} is too big`);
      return b ? b.slice() : null;
    },
    async put(key, body) {
      files.set(key, bytesOf(body).slice());
    },
    async copy(from, to) {
      const b = files.get(from);
      if (!b) return false;
      files.set(to, b.slice());
      return true;
    },
    async exists(key) {
      return files.has(key);
    },
    async remove(key) {
      files.delete(key);
    },
  };
}

/** Objects as files under `root` (keys are paths), so a test server can hand them to the browser. */
export function folderStore(root: string): Store {
  const path = (key: string) => {
    if (key.split("/").some((p) => p === ".." || p === "")) throw new Error(`bad key ${key}`);
    return join(root, key);
  };
  return {
    async get(key, maxBytes) {
      if (!existsSync(path(key))) return null;
      const b = readFileSync(path(key));
      if (b.length > maxBytes) throw new Error(`${key} is too big`);
      return new Uint8Array(b);
    },
    async put(key, body) {
      mkdirSync(dirname(path(key)), { recursive: true });
      writeFileSync(path(key), bytesOf(body));
    },
    async copy(from, to) {
      if (!existsSync(path(from))) return false;
      mkdirSync(dirname(path(to)), { recursive: true });
      copyFileSync(path(from), path(to));
      return true;
    },
    async exists(key) {
      return existsSync(path(key));
    },
    async remove(key) {
      rmSync(path(key), { force: true });
    },
  };
}

export type Backend = {
  /** the run a request is for, as the route would load it from the database (null: "gone") */
  run: (lang: string, generation: number) => Run | null;
  claude: ClaudeClient;
  eleven: { apiKey: string; api: string };
  markVoiced: (run: Run) => Promise<void>;
};

/** One produce route call: POST /api/jobs/<id>/produce/<lang>/<step> with `body`, answered like the route does. */
export async function handleStep(b: Backend, path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const m = /\/produce\/([a-z]{2})\/(translate|tts|fit)$/.exec(path);
  if (!m) return { status: 404, json: { error: "no such route" } };
  const [, lang, name] = m;
  try {
    const run = b.run(lang, Number(body.generation));
    if (!run) throw new ProduceError("this language was stopped or started again", { status: 409, code: "gone" });
    const out = name === "translate"
      ? await translateStep(run, b.claude, { kind: body.kind as "translate" | "rewrite", round: body.round as number | undefined })
      : name === "tts"
        ? await ttsStep(run, b.eleven, { round: Number(body.round), beat: Number(body.beat) })
        : await fitStep(run, { round: Number(body.round) }, () => b.markVoiced(run));
    return { status: 200, json: out };
  } catch (e) {
    const err = e instanceof ProduceError ? e : new ProduceError(`something went wrong on the server: ${(e as Error).message}`, { status: 500, retry: true });
    return { status: err.status, json: err.toJSON() };
  }
}

/**
 * test/e2e's backend: one job of one person, every language at run 1, files in `root`, the fake APIs at the given
 * addresses (test/mocks.mjs).
 */
export function folderBackend(o: { root: string; userId: string; jobId: string; voice: string; claudeUrl: string; elevenUrl: string }) {
  const store = folderStore(o.root);
  const voiced: string[] = [];
  const b: Backend = {
    run: (lang, generation) => (generation === 1 ? {
      store, userId: o.userId, jobId: o.jobId, lang, generation, voice: o.voice,
      analysisKey: `u/${o.userId}/${o.jobId}/analysis.json`,
    } : null),
    claude: new Anthropic({ apiKey: "fake-claude-key", baseURL: o.claudeUrl, maxRetries: 0 }),
    eleven: { apiKey: "fake-eleven-key", api: o.elevenUrl },
    markVoiced: async (run) => void voiced.push(run.lang),
  };
  return { b, store, voiced };
}

/** A fetch that answers the produce routes from `b` (for lib/produce/run.ts in Node). */
export function fetchVia(b: Backend, onCall?: (path: string, body: Record<string, unknown>) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    init?.signal?.throwIfAborted();
    onCall?.(path, body);
    const { status, json } = await handleStep(b, path, body);
    init?.signal?.throwIfAborted();
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
