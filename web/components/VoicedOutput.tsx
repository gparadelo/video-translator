"use client";

import { useEffect, useRef, useState } from "react";
import { Bar, Button, Card, Notice, Pill } from "@/components/ui";
import { langName, type Job, type Output } from "@/lib/jobs";
import { useRenderGuard } from "@/lib/render/guard";
import type { BuildProgress } from "@/lib/pipeline/run";

// A language whose voice the worker recorded: this tab builds its timing plan and voice track (lib/pipeline)
// and uploads them; the card then becomes the render card (ReadyOutput). It starts by itself, and starts
// again whenever the page is opened while the language is still waiting, so a closed tab never leaves it stuck.

let loading: Promise<typeof import("@/lib/pipeline/run")> | null = null;
const loadPipeline = () => {
  loading ??= import("@/lib/pipeline/run").catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
};

// One language at a time in this tab: the work is short, and each one uses the whole CPU for a moment.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function stepText(p: BuildProgress) {
  const pct = `${Math.round(p.fraction * 100)}%`;
  if (p.stage === "loading") return `Getting the recorded voice · ${pct}`;
  if (p.stage === "building") return "Fitting the video to the voice…";
  return `Saving the voice track · ${pct}`;
}

export function VoicedOutput({ job, output: o, support, onSaved }: {
  job: Job;
  output: Output;
  /** null when this browser can make the videos, a message when it can't, undefined while checking */
  support: string | null | undefined;
  onSaved: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useRenderGuard(progress !== null);

  useEffect(() => {
    if (support !== null) return;
    const ac = new AbortController();
    abort.current = ac;
    oneAtATime(async () => {
      if (ac.signal.aborted) return;
      setError("");
      setProgress({ stage: "loading", fraction: 0 });
      const m = await loadPipeline().catch(() => {
        throw new Error("the video tools didn't load. Reload the page to try again");
      });
      await m.prepareVoice(job.id, o.lang, (p) => !ac.signal.aborted && setProgress(p), ac.signal);
    }).then(
      () => {
        if (!ac.signal.aborted) void onSaved();
      },
      (e) => {
        if (ac.signal.aborted || (e as Error).name === "AbortError") return;
        const msg = (e as Error).message || "something went wrong";
        // translated again meanwhile: the page shows the new run as soon as it reloads
        if (/changed while/.test(msg)) void onSaved();
        else setError(msg);
      },
    ).finally(() => {
      if (!ac.signal.aborted) setProgress(null);
    });
    return () => ac.abort(); // the card goes away (e.g. translated again) or the page closes
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per generation and attempt
  }, [support, job.id, o.lang, o.generation, attempt]);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{langName(o.lang)}</h2>
        <Pill tone={error ? "bad" : "busy"}>{error ? "Stopped" : "Almost ready"}</Pill>
      </div>
      {error ? (
        <>
          <Notice tone="bad">Couldn&apos;t prepare the voice track: {error}</Notice>
          <Button kind="plain" className="self-start" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </>
      ) : progress ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{stepText(progress)}</p>
          <Bar fraction={progress.stage === "building" ? 1 : progress.fraction} />
          <p className="text-xs text-neutral-500">This takes a few seconds. Keep this tab open until it&apos;s done.</p>
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          {support === undefined ? "Checking this browser…" : support ?? "Waiting for the other languages…"}
        </p>
      )}
    </Card>
  );
}
