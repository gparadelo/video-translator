"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Page } from "@/components/Header";
import { LanguagePicker } from "@/components/LanguagePicker";
import { ReadyOutput, useBrowserSupport } from "@/components/RenderOutput";
import { TitlesCard } from "@/components/Titles";
import { VoicedOutput } from "@/components/VoicedOutput";
import { Bar, Button, Card, Notice, Pill, StatusPill } from "@/components/ui";
import {
  api,
  langName,
  megabytes,
  progressText,
  splitBeats,
  uploadVideo,
  workerOnline,
  type Job,
  type Output,
  type Worker,
} from "@/lib/jobs";
import { useRenderGuard } from "@/lib/render/guard";
import { createClient } from "@/lib/supabase/client";
import { usePoll } from "@/lib/use-poll";

type Loaded = { job: Job | null; outputs: Output[]; online: boolean };
type Act = (fn: string, args?: Record<string, unknown>) => Promise<void>;

// One project: its title in every language (if it has one), and for its video whatever the current step
// needs (finish the upload, wait, review the transcript, watch progress, get the results).
export default function JobPage() {
  return (
    <Suspense fallback={<Page><p className="text-sm text-neutral-500">Loading…</p></Page>}>
      <JobView />
    </Suspense>
  );
}

function JobView() {
  const { id } = useParams<{ id: string }>();
  const [supabase] = useState(createClient);
  const [error, setError] = useState("");

  const [data, refresh] = usePoll<Loaded>(async () => {
    const [job, outputs, workers] = await Promise.all([
      supabase.from("jobs").select("*").eq("id", id).maybeSingle(),
      supabase.from("job_outputs").select("*").eq("job_id", id).order("lang"),
      supabase.from("workers").select("id, last_seen"),
    ]);
    if (job.error) throw job.error;
    return {
      job: job.data as Job | null,
      outputs: (outputs.data ?? []) as Output[],
      online: workerOnline(workers.data as Worker[] | null, Date.now()),
    };
  }, 3000);

  // Move the job forward (approve, retry, cancel): these are database functions the person may call.
  const act: Act = async (fn, args = {}) => {
    setError("");
    const { error } = await supabase.rpc(fn, { p_job: id, ...args });
    if (error) setError(error.message);
    await refresh();
  };

  if (!data) return <Page><p className="text-sm text-neutral-500">Loading…</p></Page>;
  const { job, outputs, online } = data;
  if (!job) {
    return (
      <Page>
        <p>This project doesn&apos;t exist (or isn&apos;t yours).</p>
        <Link href="/" className="underline">Back to your projects</Link>
      </Page>
    );
  }

  if (!job.has_video) {
    return (
      <Page>
        <h1 className="min-w-0 truncate text-xl font-semibold">{job.name}</h1>
        <TitlesCard job={job} onSaved={refresh} />
      </Page>
    );
  }

  const waiting = job.status === "queued" || job.status === "approved";
  const working = job.status === "preparing" || job.status === "producing";
  // also while more languages wait for the worker (approved), so a video rendering in this tab keeps going
  const showOutputs = outputs.length > 0 && ["approved", "producing", "done", "failed"].includes(job.status);

  return (
    <Page>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 truncate text-xl font-semibold">{job.name}</h1>
        <StatusPill status={job.status} />
        {(waiting || working || job.status === "needs_review" || job.status === "uploading") && (
          <button
            onClick={() => confirm("Cancel this video?") && act("cancel_job")}
            className="ml-auto text-sm text-neutral-500 underline"
          >
            Cancel
          </button>
        )}
      </div>

      {error && <Notice tone="bad">{error}</Notice>}
      {(waiting || working) && !online && (
        <Notice tone="action">
          The worker Mac is offline. This video will {working ? "continue" : "start"} when it&apos;s back on.
        </Notice>
      )}

      {job.status !== "canceled" && <TitlesCard job={job} onSaved={refresh} />}

      {job.status === "uploading" && <FinishUpload job={job} onDone={refresh} />}

      {(waiting || working) && (
        <Card className="flex flex-col gap-2">
          <p className="font-medium">
            {waiting
              ? "Waiting for the worker Mac to pick this up…"
              : (progressText(job.progress) ?? (job.status === "preparing" ? "Transcribing…" : "Translating…"))}
            {working && job.progress?.lang && ` (${langName(job.progress.lang)})`}
          </p>
          {working && job.progress?.total ? <Bar fraction={(job.progress.done ?? 0) / job.progress.total} /> : null}
          <p className="text-sm text-neutral-500">
            {job.status === "producing" || job.status === "approved"
              ? "Each language takes a few minutes. You can close this page and come back."
              : "This takes a minute or two. Then you check the transcript before anything is translated."}
          </p>
        </Card>
      )}

      {job.status === "failed" && (
        <Notice tone="bad">
          <p className="font-medium">This didn&apos;t work.</p>
          <p>{job.error}</p>
          {!job.script && (
            <Button kind="plain" className="mt-3" onClick={() => act("retry_job")}>
              Try again
            </Button>
          )}
        </Notice>
      )}

      {job.status === "canceled" && <Notice tone="idle">You canceled this video.</Notice>}

      {(job.status === "needs_review" || (job.status === "failed" && job.script)) && (
        <Review key={`${job.id}-${job.status}`} job={job} act={act} />
      )}

      {showOutputs && <Outputs job={job} outputs={outputs} refresh={refresh} />}

      {job.status === "done" && <MoreLanguages job={job} outputs={outputs} act={act} />}
    </Page>
  );
}

/** The upload didn't finish (page closed, connection dropped): choose the file again. */
function FinishUpload({ job, onDone }: { job: Job; onDone: () => Promise<void> }) {
  const [fraction, setFraction] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function upload(file: File) {
    setError("");
    if (file.size !== job.source_bytes) {
      setError(`That isn't the same file (${megabytes(file.size)} instead of ${megabytes(job.source_bytes)}). Choose "${job.source_filename}".`);
      return;
    }
    setFraction(0);
    try {
      const { upload } = await api<{ upload: { url: string; headers: Record<string, string> } }>(`/api/jobs/${job.id}/upload-url`);
      await uploadVideo(file, upload, setFraction);
      await api(`/api/jobs/${job.id}/submit`);
      await onDone();
    } catch (e) {
      setError(`The upload failed: ${(e as Error).message}. Try again.`);
    }
    setFraction(null);
  }

  return (
    <Card className="flex flex-col gap-3">
      <p className="font-medium">The upload didn&apos;t finish.</p>
      {fraction === null ? (
        <label className="text-sm">
          Choose <b>{job.source_filename}</b> again to continue:
          <input
            type="file"
            accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            className="mt-2 block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-neutral-200 file:px-3 file:py-1.5 dark:file:bg-neutral-700"
          />
        </label>
      ) : (
        <>
          <Bar fraction={fraction} />
          <p className="text-sm text-neutral-500">Uploading… {Math.round(fraction * 100)}%. Keep this page open.</p>
        </>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </Card>
  );
}

/** Check the transcript and the languages, then start the translation. */
function Review({ job, act }: { job: Job; act: Act }) {
  const [beats, setBeats] = useState(() => splitBeats(job.script ?? ""));
  const [languages, setLanguages] = useState(job.languages.filter((l) => l !== job.base_lang));
  const [sending, setSending] = useState(false);
  const edited = beats.join("\n\n") !== splitBeats(job.script ?? "").join("\n\n");

  async function approve() {
    setSending(true);
    await act("approve_job", { p_script: edited ? beats.join("\n\n") : null, p_languages: languages });
    setSending(false);
  }

  return (
    <>
      {job.warnings.map((w) => (
        <Notice key={w} tone="action">{w}</Notice>
      ))}
      <Card className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Check the transcript</h2>
          <p className="text-sm text-neutral-500">
            This is what the voiceover says{job.base_lang ? ` (${langName(job.base_lang)})` : ""}. Fix the spelling of
            names if needed, but keep the words exactly as spoken: the timing depends on them.
          </p>
        </div>
        {job.names_fixed.length > 0 && (
          <p className="text-sm text-neutral-500">Already corrected: {job.names_fixed.join("; ")}.</p>
        )}
        <ol className="flex flex-col gap-2">
          {beats.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-5 pt-2 text-right text-xs text-neutral-400">{i + 1}</span>
              <textarea
                value={b}
                rows={Math.max(1, Math.ceil(b.length / 75))}
                onChange={(e) => setBeats(beats.map((x, k) => (k === i ? e.target.value.replace(/\n/g, " ") : x)))}
                className="field-sizing-content min-w-0 flex-1 resize-none rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm leading-relaxed dark:border-neutral-700"
              />
            </li>
          ))}
        </ol>
      </Card>
      <Card className="flex flex-col gap-3">
        <h2 className="font-medium">Translate into</h2>
        <LanguagePicker value={languages} onChange={setLanguages} exclude={job.base_lang} />
      </Card>
      <Button
        className="self-start"
        disabled={sending || languages.length === 0 || beats.some((b) => !b.trim())}
        onClick={approve}
      >
        {job.status === "failed" ? "Try again" : `Translate into ${languages.length} language${languages.length === 1 ? "" : "s"}`}
      </Button>
    </>
  );
}

/**
 * One card per language: its progress, or the video to watch and download. A language that is ready is
 * rendered here in the browser (ReadyOutput); older projects have their videos in storage.
 */
function Outputs({ job, outputs, refresh }: { job: Job; outputs: Output[]; refresh: () => Promise<void> }) {
  const missing = job.status === "producing" ? job.languages.filter((l) => l !== job.base_lang && !outputs.some((o) => o.lang === l)) : [];
  const rendered = outputs.filter((o) => o.status === "done" && o.output_key);
  // voiced: this tab builds the voice track first; ready: it renders. Older projects need neither.
  const anyReady = outputs.some((o) => o.status === "ready" || o.status === "voiced");
  const support = useBrowserSupport(anyReady); // older projects don't need the render code
  const [busy, setBusy] = useState<string | null>(null); // the language rendering now: one at a time
  useRenderGuard(busy !== null);
  return (
    <>
    {rendered.length > 0 && <DownloadAll jobId={job.id} outputs={rendered} />}
    {anyReady && support && <Notice tone="action">{support}</Notice>}
    <div className="grid gap-4 sm:grid-cols-2">
      {outputs.map((o) => o.status === "voiced" ? (
        <VoicedOutput key={`${o.lang}-${o.generation}`} job={job} output={o} support={support} onSaved={refresh} />
      ) : o.status === "ready" ? (
        <ReadyOutput
          key={`${o.lang}-${o.generation}`}
          job={job}
          output={o}
          support={support}
          othersBusy={busy !== null && busy !== o.lang}
          onBusy={(b) => setBusy(b ? o.lang : null)}
          onSaved={refresh}
        />
      ) : (
        <Card key={o.lang} className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">{langName(o.lang)}</h2>
            {o.status === "done" && <Pill tone={o.flags.length ? "action" : "good"}>{o.flags.length ? "Check it" : "Ready"}</Pill>}
            {o.status === "running" && <Pill tone="busy">Working</Pill>}
            {o.status === "pending" && <Pill tone="idle">Waiting</Pill>}
            {o.status === "failed" && <Pill tone="bad">Failed</Pill>}
          </div>
          {o.status === "done" && o.preview_key && (
            <video
              controls
              preload="metadata"
              src={`/api/jobs/${job.id}/files/${o.lang}?kind=preview`}
              className="max-h-[28rem] w-full rounded-lg bg-black"
            />
          )}
          {o.status === "done" && o.flags.length > 0 && (
            <div className="text-sm">
              <p className="font-medium">Worth a look:</p>
              <ul className="list-disc pl-5 text-neutral-600 dark:text-neutral-400">
                {o.flags.map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          )}
          {o.status === "failed" && <p className="text-sm text-red-700 dark:text-red-300">{o.flags[0]}</p>}
          {o.status === "done" && o.output_key && (
            <a
              href={`/api/jobs/${job.id}/files/${o.lang}`}
              className="self-start rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Download{o.output_bytes ? ` · ${megabytes(o.output_bytes)}` : ""}
            </a>
          )}
        </Card>
      ))}
      {missing.map((l) => (
        <Card key={l} className="flex items-center justify-between">
          <h2 className="font-medium">{langName(l)}</h2>
          <Pill tone="idle">Waiting</Pill>
        </Card>
      ))}
    </div>
    </>
  );
}

/**
 * Downloads every finished language, one after another. Each one goes through the same route as its own
 * Download button (a signed R2 link sent as an attachment), so the files go straight from R2 to the browser.
 * The pause between them keeps browsers from dropping all but the first; they may ask once to allow
 * this site to download several files.
 */
function DownloadAll({ jobId, outputs }: { jobId: string; outputs: Output[] }) {
  const [busy, setBusy] = useState(false);
  const total = outputs.reduce((n, o) => n + (o.output_bytes ?? 0), 0);

  async function downloadAll() {
    setBusy(true);
    for (const [i, o] of outputs.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const a = document.createElement("a");
      a.href = `/api/jobs/${jobId}/files/${o.lang}`;
      a.download = ""; // a download, not a navigation, so the next one doesn't cancel this one
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button kind="plain" disabled={busy} onClick={downloadAll}>
        {busy ? "Downloading…" : `Download all (${outputs.length})${total ? ` · ${megabytes(total)}` : ""}`}
      </Button>
      {outputs.length > 1 && (
        <p className="text-xs text-neutral-500">Your browser may ask once to allow several downloads.</p>
      )}
    </div>
  );
}

/** After it's done: add languages (the transcript and voice settings are reused). */
function MoreLanguages({ job, outputs, act }: { job: Job; outputs: Output[]; act: Act }) {
  const [languages, setLanguages] = useState<string[]>([]);
  const failed = outputs.filter((o) => o.status === "failed").map((o) => o.lang);
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-medium">Translate into more languages</h2>
      <LanguagePicker value={languages} onChange={setLanguages} exclude={job.base_lang} />
      <div className="flex flex-wrap gap-2">
        <Button kind="plain" disabled={languages.length === 0} onClick={() => act("approve_job", { p_languages: languages })}>
          Translate
        </Button>
        {failed.length > 0 && (
          <Button kind="plain" onClick={() => act("approve_job", { p_languages: failed })}>
            Retry {failed.map(langName).join(", ")}
          </Button>
        )}
      </div>
      <p className="text-xs text-neutral-500">Files are kept for 30 days. Download the ones you want to keep.</p>
    </Card>
  );
}
