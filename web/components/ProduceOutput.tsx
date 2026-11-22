"use client";

import { useEffect, useState } from "react";
import { Bar, Button, Card, Notice, Pill } from "@/components/ui";
import { langName, type Job, type Output } from "@/lib/jobs";
import { useRenderGuard } from "@/lib/render/guard";
import { RunGone, produceLanguage, type ProduceProgress, type Waiting } from "@/lib/produce/run";
import { createClient } from "@/lib/supabase/client";

// A language being made on this page (lib/produce/run.ts): translated, voiced beat by beat and fitted, with the
// person's own keys, until it is voiced; the card then becomes the voiced card (VoicedOutput) and the render card.
// It starts by itself whenever the page is open: a waiting language gets a new run (start_run), a running one
// carries on from what's saved. One tab of this browser works on a language at a time (Web Locks).

type Lock = { request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void>): Promise<void> };
const locks = () => (globalThis.navigator as Navigator & { locks?: Lock } | undefined)?.locks;

function stepText(p: ProduceProgress | null) {
  if (!p) return "Starting…";
  switch (p.stage) {
    case "translating":
      return p.attempt ? "Translating… (Claude is fixing its first answer)" : "Translating…";
    case "voicing":
      return `Recording the voice · ${p.done} of ${p.total}`;
    case "fitting":
      return "Fitting the video to the voice…";
    case "rewriting":
      return `Adjusting the translation to fit · round ${p.round} of ${p.of}`;
  }
}

export function ProduceOutput({ job, output: o, onChanged }: { job: Job; output: Output; onChanged: () => Promise<void> }) {
  const [supabase] = useState(createClient);
  const [progress, setProgress] = useState<ProduceProgress | null>(null);
  const [waiting, setWaiting] = useState<Waiting>(null);
  const [error, setError] = useState("");
  const [elsewhere, setElsewhere] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(false);
  useRenderGuard(active);

  useEffect(() => {
    const ac = new AbortController();
    const stop = () => ac.signal.aborted;

    async function make() {
      if (o.status === "pending") {
        // a new run; the poll then shows it running, and this card goes on with it
        const { error: e } = await supabase.rpc("start_run", { p_job: job.id, p_lang: o.lang });
        if (stop()) return;
        if (e && !/already being made/.test(e.message)) setError(e.message);
        await onChanged();
        return;
      }
      setActive(true);
      try {
        await produceLanguage({
          jobId: job.id, lang: o.lang, generation: o.generation, signal: ac.signal,
          onProgress: (p) => !stop() && setProgress(p),
          onWaiting: (w) => !stop() && setWaiting(w),
        });
        if (!stop()) await onChanged();
      } catch (e) {
        if (stop() || (e as Error).name === "AbortError") return;
        if (e instanceof RunGone) {
          await onChanged();
          return;
        }
        const msg = (e as Error).message || "something went wrong";
        // the language fails with the reason; Try again starts a new run that reuses everything already made
        const { error: f } = await supabase.rpc("fail_run", { p_job: job.id, p_lang: o.lang, p_generation: o.generation, p_error: msg });
        if (f) setError(msg); // couldn't record it: show it here, Try again carries on with this run
        await onChanged();
      } finally {
        if (!stop()) {
          setActive(false);
          setWaiting(null);
        }
      }
    }

    const l = locks();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const take = () => {
      if (!l || o.status === "pending") return void make(); // start_run itself lets only one tab start a run
      void l.request(`vt-produce:${job.id}:${o.lang}`, { ifAvailable: true }, async (lock) => {
        if (stop()) return;
        if (!lock) {
          setElsewhere(true);
          retry = setTimeout(take, 5000); // the other tab may close
          return;
        }
        setElsewhere(false);
        await make(); // the lock is held until this run stops (finished, failed, or the card goes away)
      });
    };
    take();
    return () => {
      ac.abort();
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per status, generation and attempt
  }, [job.id, o.lang, o.status, o.generation, attempt]);

  const voicing = progress?.stage === "voicing" ? progress : null;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{langName(o.lang)}</h2>
        <Pill tone={error ? "bad" : "busy"}>{error ? "Stopped" : "Working"}</Pill>
      </div>
      {error ? (
        <>
          <Notice tone="bad">{error}</Notice>
          <Button kind="plain" className="self-start" onClick={() => {
            setError("");
            setAttempt((n) => n + 1);
          }}>
            Try again
          </Button>
        </>
      ) : elsewhere ? (
        <p className="text-sm text-neutral-500">Being made in another tab of this browser.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{o.status === "pending" ? "Starting…" : stepText(progress)}</p>
          {voicing ? <Bar fraction={voicing.total ? voicing.done / voicing.total : 0} /> : null}
          {waiting && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {waiting.reason.replace(/ - trying again$/, "")}. Trying again in {waiting.seconds} s…
            </p>
          )}
          <p className="text-xs text-neutral-500">Keep this tab open until it&apos;s done. If it closes, it carries on from here next time.</p>
        </div>
      )}
    </Card>
  );
}
