"use client";

import { useEffect, useRef, useState } from "react";
import { Bar, Button, Card, Notice, Pill } from "@/components/ui";
import { langName, type Job, type Output } from "@/lib/jobs";
import { HEARTBEAT, interruptedRender, saveRunning, type Running } from "@/lib/render/guard";
import { durationText, qualityLabel, type QualityId } from "@/lib/render/quality";
import type { Choice, Progress } from "@/lib/render/run";

// A language that is ready (plan + voice track): the video is rendered here, in the browser.
// First a 720p preview, which is uploaded so it plays on this page; then, on Download, the full quality,
// saved on this computer.

type RenderModules = { run: typeof import("@/lib/render/run"); save: typeof import("@/lib/render/save") };
let modules: RenderModules | null = null;
let loading: Promise<RenderModules> | null = null;

/** The render code is big (Mediabunny), so it loads only on pages that need it. */
function loadRender() {
  loading ??= Promise.all([import("@/lib/render/run"), import("@/lib/render/save")]).then(
    ([run, save]) => (modules = { run, save }),
    (e) => {
      loading = null; // try again next time
      throw e;
    },
  );
  return loading;
}

/**
 * null when this browser can render, a message when it can't, undefined while checking (or while `needed`
 * is false: then nothing is loaded).
 */
export function useBrowserSupport(needed: boolean) {
  const [support, setSupport] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!needed) return;
    let live = true;
    loadRender()
      .then(
        (m) => m.run.checkBrowser(),
        () => "The video tools didn't load. Reload the page to try again.",
      )
      .catch(() => "This browser can't make the videos. Use Chrome or Edge on a computer.")
      .then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, [needed]);
  return support;
}

// Speed tests run one at a time, so they don't slow each other down.
let measuring: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = measuring.then(fn, fn);
  measuring = next.catch(() => {});
  return next;
}

type Task = { kind: Running["kind"]; progress: Progress };

function taskText(t: Task) {
  const pct = `${Math.round(t.progress.fraction * 100)}%`;
  if (t.progress.stage === "loading") return "Getting the files…";
  if (t.progress.stage === "uploading") return `Uploading the preview · ${pct}`;
  return t.kind === "preview" ? `Making the preview · ${pct}` : `Rendering · ${pct}`;
}

export function ReadyOutput({
  job,
  output: o,
  support,
  othersBusy,
  onBusy,
  onSaved,
}: {
  job: Job;
  output: Output;
  support: string | null | undefined;
  /** Another language is rendering: one at a time. */
  othersBusy: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  // the card only appears after the page loaded its data in the browser, so localStorage is there
  const [interrupted, setInterrupted] = useState(() => interruptedRender(job.id, o.lang));
  const abort = useRef<AbortController | null>(null);
  const supported = support === null;
  const canStart = supported && !task && !othersBusy;

  // The card goes away when this language stops being ready (e.g. it's translated again): stop its render.
  useEffect(() => () => abort.current?.abort(), []);

  async function run(kind: Running["kind"], work: (signal: AbortSignal, onProgress: (p: Progress) => void) => Promise<void>) {
    setError("");
    setSaved("");
    setInterrupted(null);
    onBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    const startedAt = Date.now();
    let fraction = 0;
    const beat = () => saveRunning(job.id, o.lang, { kind, startedAt, fraction, seenAt: Date.now() });
    beat();
    const heartbeat = setInterval(beat, HEARTBEAT);
    setTask({ kind, progress: { stage: "loading", fraction: 0 } });
    try {
      await work(ac.signal, (progress) => {
        fraction = progress.fraction;
        if (!ac.signal.aborted) setTask({ kind, progress });
      });
      return true;
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message || "something went wrong");
      return false;
    } finally {
      clearInterval(heartbeat);
      saveRunning(job.id, o.lang, null);
      abort.current = null;
      setTask(null);
      onBusy(false);
    }
  }

  async function preview() {
    let m: RenderModules;
    try {
      m = modules ?? (await loadRender());
    } catch {
      setError("the video tools didn't load. Reload the page to try again");
      return;
    }
    if (await run("preview", (signal, onProgress) => m.run.makePreview(job.id, o.lang, onProgress, signal))) await onSaved();
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{langName(o.lang)}</h2>
        <Pill tone={o.flags.length ? "action" : "good"}>{o.flags.length ? "Check it" : "Ready"}</Pill>
      </div>

      {o.preview_key ? (
        <video
          controls
          preload="metadata"
          src={`/api/jobs/${job.id}/files/${o.lang}?kind=preview&v=${o.preview_bytes ?? ""}`}
          className="max-h-[28rem] w-full rounded-lg bg-black"
        />
      ) : (
        !task && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Make a preview to check that the cuts land on the right words. It&apos;s made here in your browser.
          </p>
        )
      )}

      {o.flags.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Worth a look:</p>
          <ul className="list-disc pl-5 text-neutral-600 dark:text-neutral-400">
            {o.flags.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}

      {interrupted && !task && (
        <Notice tone="action">
          The last {interrupted.kind === "preview" ? "preview" : "download"} stopped before it finished (the page was
          closed or reloaded). Start it again.
        </Notice>
      )}
      {error && <Notice tone="bad">It didn&apos;t work: {error}</Notice>}

      {task ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{taskText(task)}</p>
          <Bar fraction={task.progress.fraction} />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-neutral-500">Keep this tab open until it&apos;s done.</p>
            <button onClick={() => abort.current?.abort()} className="text-sm text-neutral-500 underline">
              Stop
            </button>
          </div>
        </div>
      ) : !o.preview_key ? (
        <Button className="self-start" disabled={!canStart} onClick={preview}>
          Make preview
        </Button>
      ) : (
        <Download job={job} output={o} canStart={canStart} run={run} saved={saved} setSaved={setSaved} />
      )}
    </Card>
  );
}

function Download({
  job,
  output: o,
  canStart,
  run,
  saved,
  setSaved,
}: {
  job: Job;
  output: Output;
  canStart: boolean;
  run: (kind: Running["kind"], work: (signal: AbortSignal, onProgress: (p: Progress) => void) => Promise<void>) => Promise<boolean>;
  saved: string;
  setSaved: (s: string) => void;
}) {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [quality, setQuality] = useState<QualityId | null>(null);
  const [checkError, setCheckError] = useState("");
  const [pickError, setPickError] = useState("");
  const [attempt, setAttempt] = useState(0);

  // how fast each quality would be on this computer (a short test encode), to suggest one
  useEffect(() => {
    let live = true;
    queued(async () => {
      const m = modules ?? (await loadRender());
      return m.run.measureChoices(job.id, o.lang);
    }).then(
      (r) => {
        if (!live) return;
        setChoices(r.choices);
        setQuality(r.pick);
      },
      (e) => live && setCheckError((e as Error).message || "something went wrong"),
    );
    return () => {
      live = false;
    };
  }, [job.id, o.lang, attempt]);

  async function download() {
    const choice = choices?.find((c) => c.quality.id === quality);
    if (!choice || !modules) return;
    const filename = modules.run.downloadName(job.name, o.lang);
    // first thing in the click: the browser only opens its "Save as" window right after a click
    setPickError("");
    let save;
    try {
      save = await modules.save.chooseSaveTarget(filename);
    } catch (e) {
      setPickError(`Couldn't save there: ${(e as Error).message}`);
      return;
    }
    if (!save) return; // closed the window
    const m = modules;
    if (await run("download", (signal, onProgress) => m.run.renderDownload(job.id, o.lang, choice, save, onProgress, signal)))
      setSaved(filename);
  }

  if (checkError) {
    return (
      <div className="flex flex-col gap-2">
        <Notice tone="bad">Couldn&apos;t get the download ready: {checkError}</Notice>
        <Button
          kind="plain"
          className="self-start"
          onClick={() => {
            setCheckError("");
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!choices) return <p className="text-sm text-neutral-500">Checking how fast this computer can make the video…</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={quality ?? ""}
          onChange={(e) => setQuality(e.target.value as QualityId)}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
        >
          {choices.map((c) => (
            <option key={c.quality.id} value={c.quality.id}>
              {qualityLabel(c.quality)}
              {c.seconds != null ? ` · ${durationText(c.seconds)}` : ""}
            </option>
          ))}
        </select>
        <Button kind="plain" disabled={!canStart || !quality} onClick={download}>
          Download
        </Button>
      </div>
      {pickError && <Notice tone="bad">{pickError}</Notice>}
      {saved ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">Saved {saved}.</p>
      ) : (
        <p className="text-xs text-neutral-500">
          The video is made here in your browser and saved on this computer. The time is an estimate.
        </p>
      )}
    </div>
  );
}

