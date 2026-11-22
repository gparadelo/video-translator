// What the job page does for a language that is being made (job_outputs running): it calls the produce steps
// (lib/produce/steps.ts, through app/api/jobs/<id>/produce/<lang>/...) one after another until the language is
// voiced, as scripts/vt.py's produce() loop does:
//
//   translate -> voice every beat -> fit -> (flags left and rounds left: rewrite -> voice -> fit ...) -> voiced
//
// Each step saves what it made, so this can stop at any point (tab closed, network gone) and start again: it then
// continues from what's saved, and beats already voiced cost nothing. Passing problems (ElevenLabs or Claude busy,
// a dropped connection, a function that ran out of time) are tried again with growing pauses; anything else ends
// the run with the step's message. Browser code, but plain enough to run in Node (the tests give it a fake fetch).

import { CLAUDE } from "./config";
import { ProduceError, type ErrorCode } from "./errors";

export type ProduceProgress =
  | { stage: "translating"; attempt: number }
  | { stage: "voicing"; done: number; total: number; round: number }
  | { stage: "fitting"; round: number }
  | { stage: "rewriting"; round: number; of: number; attempt: number };

export type Waiting = { seconds: number; reason: string } | null;

export type ProduceOptions = {
  jobId: string;
  lang: string;
  generation: number;
  onProgress?: (p: ProduceProgress) => void;
  /** a passing problem: trying again in `seconds` (null once it goes on) */
  onWaiting?: (w: Waiting) => void;
  signal?: AbortSignal;
  /** for tests */
  fetchFn?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** How many beats are voiced at once, over all languages in this tab (ElevenLabs' cheaper plans allow 2-3). */
export const TTS_AT_ONCE = 2;
/** How many Claude calls at once, over all languages in this tab. */
export const CLAUDE_AT_ONCE = 2;
/** Tries of one step before the language fails, and the pauses between them (seconds, before jitter). */
export const TRIES = 6;
const PAUSES = [2, 5, 10, 20, 30];

/** At most `n` at a time. */
class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((res) => this.waiting.push(res)); // handed a slot
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // the slot goes straight to the next one
      else this.active--;
    }
  }
}
const ttsGate = new Gate(TTS_AT_ONCE);
const claudeGate = new Gate(CLAUDE_AT_ONCE);

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("stopped", "AbortError"));
    }, { once: true });
  });

/** The run is over (canceled, or started again elsewhere): nothing to show but where the language is now. */
export class RunGone extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunGone";
  }
}

type Answer = { error?: string; retry?: boolean; after?: number; code?: ErrorCode };

/** POST one step, tried again on passing problems. Throws ProduceError (or RunGone, or the abort). */
async function step<T>(o: ProduceOptions, name: string, body: Record<string, unknown>): Promise<T> {
  const fetchFn = o.fetchFn ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const url = `/api/jobs/${o.jobId}/produce/${o.lang}/${name}`;
  for (let attempt = 1; ; attempt++) {
    o.signal?.throwIfAborted();
    let status = 0;
    let data: Answer & T;
    try {
      const r = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generation: o.generation, ...body }),
        signal: o.signal,
      });
      status = r.status;
      data = (await r.json().catch(() => ({}))) as Answer & T;
      if (r.ok) {
        o.onWaiting?.(null);
        return data;
      }
    } catch (e) {
      if (o.signal?.aborted) throw e;
      data = { error: "the connection dropped", retry: true } as Answer & T;
    }
    if (data.code === "gone") throw new RunGone(data.error ?? "this language was stopped");
    // 429 and 5xx without an answer of ours: the platform (a timeout, a deploy, too many requests)
    const passing = data.retry || status === 429 || (status >= 500 && !data.error) || status === 502 || status === 503 || status === 504;
    if (!passing || attempt >= TRIES) {
      throw new ProduceError(data.error ?? `something went wrong (${status})`, { status, code: data.code });
    }
    const base = Math.max(PAUSES[Math.min(attempt - 1, PAUSES.length - 1)], Math.min(data.after ?? 0, 60));
    const seconds = Math.round(base * (0.8 + 0.4 * Math.random()));
    o.onWaiting?.({ seconds, reason: data.error ?? `the server answered ${status}` });
    await sleep(seconds * 1000, o.signal);
  }
}

type Translated = { done: true; round: number; beats: number } | { done: false; problems: string[]; attempt: number };

/** One translate step until Claude's answer has no problems (each try is one call; the step keeps the conversation). */
async function translate(o: ProduceOptions, kind: "translate" | "rewrite", round?: number) {
  for (let attempt = 0; ; attempt++) {
    if (kind === "translate") o.onProgress?.({ stage: "translating", attempt });
    else o.onProgress?.({ stage: "rewriting", round: (round ?? 0) + 1, of: CLAUDE.fix_rounds, attempt });
    const r = await claudeGate.run(() => step<Translated>(o, "translate", { kind, round }));
    if (r.done) return r;
  }
}

/** Make one language up to its recorded voice. Resolves once it is voiced. */
export async function produceLanguage(o: ProduceOptions): Promise<void> {
  for (let restart = 0; ; restart++) {
    try {
      let s = await translate(o, "translate");
      for (;;) {
        let done = 0;
        o.onProgress?.({ stage: "voicing", done, total: s.beats, round: s.round });
        const beats = Array.from({ length: s.beats }, (_, i) => i);
        // every beat, at most TTS_AT_ONCE at a time; the first problem stops the others from starting
        let failed: unknown = null;
        await Promise.all(beats.map((beat) => ttsGate.run(async () => {
          if (failed) return;
          try {
            await step(o, "tts", { round: s.round, beat });
            o.onProgress?.({ stage: "voicing", done: ++done, total: s.beats, round: s.round });
          } catch (e) {
            failed ??= e;
          }
        })));
        if (failed) throw failed;
        o.onProgress?.({ stage: "fitting", round: s.round });
        const f = await step<{ voiced: boolean; round: number }>(o, "fit", { round: s.round });
        if (f.voiced) return;
        s = await translate(o, "rewrite", s.round);
      }
    } catch (e) {
      // the translation moved on under us (another tab of this person, or an answer that came too late): go on
      // from where it is now, which costs nothing for what's already saved
      if (e instanceof ProduceError && e.code === "stale" && restart < 3) continue;
      throw e;
    }
  }
}
