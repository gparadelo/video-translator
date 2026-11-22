"use client";

import { useState } from "react";
import { Button, Card, Notice } from "@/components/ui";
import { api, LANGS, langName, type Job } from "@/lib/jobs";
import { MAX_TITLE, NON_LATIN } from "@/lib/titles";

/** "Written in": the title's language, or detect it. */
export function TitleLanguage({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      Written in
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="self-start rounded-lg border border-neutral-300 bg-transparent px-3 py-2 font-normal dark:border-neutral-700"
      >
        <option value="auto">Detect automatically</option>
        {Object.keys(LANGS).map((c) => (
          <option key={c} value={c}>
            {langName(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The project's title in every language, each with a Copy button. Also where a title is added (to a video
 * project that has none), changed, or translated into languages added to the project later.
 */
export function TitlesCard({ job, onSaved }: { job: Job; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function translate(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/jobs/${job.id}/title`, body);
      await onSaved();
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  const original = job.title_lang;
  const targets = job.languages.filter((l) => l !== original);
  const missing = targets.filter((l) => !job.titles[l]);
  const translated = Object.keys(job.titles).length > 0;

  if (!job.title && !editing) {
    return (
      <Card className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">No title in this project.</p>
        <Button kind="plain" onClick={() => setEditing(true)}>
          Add a title
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-0 pt-5">
      <div className="flex flex-wrap items-center gap-3 px-5">
        <h2 className="font-medium">Title</h2>
        {!editing && (
          <button onClick={() => setEditing(true)} className="ml-auto text-sm text-neutral-500 underline">
            Change
          </button>
        )}
      </div>

      {editing && <EditTitle job={job} busy={busy} onCancel={() => setEditing(false)} onSubmit={translate} />}
      {error && (
        <div className="px-5">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}

      {!editing && !translated && (
        <div className="flex flex-col gap-3 px-5 pb-5">
          <p className="text-sm">
            <span className="text-neutral-500">Not translated yet:</span> {job.title}
          </p>
          <Button className="self-start" disabled={busy} onClick={() => translate({})}>
            {busy ? "Translating…" : `Translate into ${targets.length} language${targets.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}

      {!editing && translated && (
        <>
          <ul className="divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {original && <Row code={original} text={job.titles[original] ?? job.title ?? ""} original />}
            {targets.map((c) => (
              <Row key={c} code={c} text={job.titles[c] ?? ""} />
            ))}
          </ul>
          {missing.length > 0 && (
            <div className="px-5 pb-5">
              <Button kind="plain" disabled={busy} onClick={() => translate({ missing: true })}>
                {busy ? "Translating…" : `Translate into ${missing.map(langName).join(", ")}`}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function EditTitle({
  job,
  busy,
  onCancel,
  onSubmit,
}: {
  job: Job;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(job.title ?? "");
  const [source, setSource] = useState(job.title_lang ?? "auto");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ title, source });
      }}
      className="flex flex-col gap-3 px-5 pb-5"
    >
      <input
        value={title}
        maxLength={300}
        autoFocus
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="The title of your video"
        className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
      />
      <TitleLanguage value={source} onChange={setSource} disabled={busy} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? "Translating…" : "Translate"}
        </Button>
        <Button kind="plain" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-neutral-500">
        Every title comes back in plain letters (no accents), at most {MAX_TITLE} characters. Languages with their own
        alphabet are written in Latin letters.
      </p>
    </form>
  );
}

function Row({ code, text, original }: { code: string; text: string; original?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. not https): the text is still there to select by hand.
    }
  }

  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-neutral-500">
          {langName(code)}
          {original && " (original)"}
          {NON_LATIN.has(code) && " - romanized"}
        </div>
        <div className="break-words">{text || <span className="text-neutral-400">Not translated yet</span>}</div>
      </div>
      <span className={`text-xs tabular-nums ${text.length > MAX_TITLE ? "text-red-600" : "text-neutral-500"}`}>
        {text.length}/{MAX_TITLE}
      </span>
      <Button kind="plain" type="button" onClick={copy} disabled={!text} className="w-20 px-2 py-1">
        {copied ? "Copied" : "Copy"}
      </Button>
    </li>
  );
}
