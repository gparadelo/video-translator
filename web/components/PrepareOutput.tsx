"use client";

import { useEffect, useState } from "react";
import { Bar, Button, Card, Notice } from "@/components/ui";
import type { Job } from "@/lib/jobs";
import { browserProblem, onPhone } from "@/lib/prepare/checks";
import { forgetFile, keptFile, measureKept } from "@/lib/prepare/files";
import { prepareJob, type PrepareProgress } from "@/lib/prepare/run";
import { RunGone, RunTaken, type Waiting } from "@/lib/produce/run";
import { useRenderGuard } from "@/lib/render/guard";
import { createClient } from "@/lib/supabase/client";
import { runnerId } from "@/lib/runner";

// A video being prepared on this page (job "preparing"), or an approved, edited transcript being timed again
// ("aligning"): lib/prepare/run.ts measures the video in this browser and drives the prepare routes, with the
// person's own keys, until the transcript is ready for review (or the job page translates it). It starts by itself
// whenever the page is open and carries on from what's saved.
//
// One browser prepares a job at a time: it holds the job in the database (hold_prepare, renewed every 20 s; the
// prepare routes answer only the holder), so another device waits instead of paying twice; inside this browser,
// one tab at a time (Web Locks).

type Lock = { request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void>): Promise<void> };
const locks = () => (globalThis.navigator as Navigator & { locks?: Lock } | undefined)?.locks;

const HOLD_EVERY = 20_000;
const LOOK_AGAIN = 15_000;

function stepText(p: PrepareProgress | null, aligning: boolean) {
  if (!p || p.stage === "starting") return aligning ? "Timing your edited transcript…" : "Starting…";
  switch (p.stage) {
    case "measuring":
      return p.part === "sound" ? "Reading the sound…" : "Finding the cuts…";
    case "uploading":
      return "Uploading the voiceover…";
    case "transcribing":
      return "Transcribing the voiceover…";
    case "names":
      return "Checking the spelling of names…";
    case "timing":
      return aligning ? "Timing your edited transcript…" : "Timing each word…";
  }
}

export function PrepareOutput({ job, onChanged }: { job: Job; onChanged: () => Promise<void> }) {
  const [supabase] = useState(createClient);
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [waiting, setWaiting] = useState<Waiting>(null);
  const [error, setError] = useState("");
  const [elsewhere, setElsewhere] = useState<"tab" | "browser" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(false);
  const [unsupported] = useState(browserProblem);
  useRenderGuard(active);
  const aligning = job.status === "aligning";

  useEffect(() => {
    if (unsupported) return;
    const ac = new AbortController();
    const stop = () => ac.signal.aborted;
    const runner = runnerId();
    let later: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      clearTimeout(later);
      if (!stop()) later = setTimeout(take, ms);
    };
    const hold = async () => {
      const { data, error: e } = await supabase.rpc("hold_prepare", { p_job: job.id, p_runner: runner });
      return e ? "error" : (data as "ok" | "taken" | "gone");
    };

    async function make() {
      const held = await hold();
      if (stop()) return;
      if (held === "gone") return void (await onChanged());
      if (held !== "ok") {
        setElsewhere(held === "taken" ? "browser" : null);
        if (held === "error") setWaiting({ seconds: Math.round(LOOK_AGAIN / 1000), reason: "couldn't reach the server" });
        return again(LOOK_AGAIN);
      }
      setElsewhere(null);
      setWaiting(null);

      const run = new AbortController();
      const off = () => run.abort();
      ac.signal.addEventListener("abort", off, { once: true });
      // "gone": the project moved on (canceled, or the last step just finished it); "taken": another browser has it
      let lost: "taken" | "gone" | null = null;
      const beat = setInterval(async () => {
        const h = await hold();
        if (h === "taken" || h === "gone") {
          lost = h;
          run.abort();
        }
      }, HOLD_EVERY);

      setActive(true);
      try {
        await prepareJob({
          jobId: job.id, runner, status: aligning ? "aligning" : "preparing", signal: run.signal,
          file: keptFile(job.id),
          measure: async (source, full, onProgress, signal) =>
            measureKept(job.id, full, onProgress, signal) ?? (await import("@/lib/prepare/local")).measureVideo(source, full, onProgress, signal),
          onProgress: (p) => !stop() && setProgress(p),
          onWaiting: (w) => !stop() && setWaiting(w),
        });
        forgetFile(job.id); // measured and saved: the tab doesn't need to keep the video any more
        if (!stop()) await onChanged();
      } catch (e) {
        if (stop()) return;
        if (e instanceof RunGone || lost === "gone") return void (await onChanged());
        if (e instanceof RunTaken || lost === "taken") {
          setElsewhere("browser");
          await onChanged();
          return again(LOOK_AGAIN);
        }
        if ((e as Error).name === "AbortError") return;
        const msg = (e as Error).message || "something went wrong";
        // the project fails with the reason; Try again (retry_job) carries on from what was made
        const { error: f } = await supabase.rpc("fail_prepare", { p_job: job.id, p_error: msg });
        if (f) setError(msg); // couldn't record it: show it here, Try again carries on
        await onChanged();
      } finally {
        clearInterval(beat);
        ac.signal.removeEventListener("abort", off);
        if (!stop()) {
          setActive(false);
          setWaiting(null);
        }
      }
    }

    const l = locks();
    function take() {
      if (stop()) return;
      if (!l) return void make();
      void l.request(`vt-prepare:${job.id}`, { ifAvailable: true }, async (lock) => {
        if (stop()) return;
        if (!lock) {
          setElsewhere("tab");
          return again(5000);
        }
        await make();
      });
    }
    take();
    return () => {
      ac.abort();
      clearTimeout(later);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per status and attempt
  }, [job.id, job.status, attempt, unsupported]);

  const fraction = progress?.stage === "measuring" || progress?.stage === "uploading" ? progress.fraction : null;
  return (
    <Card className="flex flex-col gap-2">
      {unsupported ? (
        <Notice tone="action">{unsupported}</Notice>
      ) : error ? (
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
        <p className="text-sm text-neutral-500">
          {elsewhere === "tab"
            ? "Being prepared in another tab of this browser."
            : "Being prepared on another device or browser. If that one was closed, this page takes over within a minute."}
        </p>
      ) : (
        <>
          <p className="font-medium">{stepText(progress, aligning)}</p>
          {fraction !== null && <Bar fraction={fraction} />}
          {waiting && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {waiting.seconds
                ? `${waiting.reason.replace(/ - trying again$/, "")}. Trying again in ${waiting.seconds} s…`
                : "No internet connection. It carries on when the connection is back."}
            </p>
          )}
          <p className="text-sm text-neutral-500">
            {aligning
              ? "Your edits are timed against the voiceover again. Then the translation starts on this page."
              : "This takes a minute or two. Then you check the transcript before anything is translated."}{" "}
            Keep this tab open; if it closes, it carries on from here next time.
            {onPhone() && " This works best in Chrome or Edge on a computer."}
          </p>
        </>
      )}
    </Card>
  );
}
