"use client";

import { useState } from "react";
import { Page } from "@/components/Header";
import { Button, Card, Notice } from "@/components/ui";
import { api, LANGS, langName } from "@/lib/jobs";
import { MAX_TITLE, NON_LATIN } from "@/lib/titles";

type Result = { source: string; titles: Record<string, string> };

// Title translator: one title in, the same title in every language, each ready to paste.
export default function Titles() {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("auto");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function translate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(await api<Result>("/api/titles", { title, source }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const codes = result ? [result.source, ...Object.keys(result.titles).filter((c) => c !== result.source)] : [];

  return (
    <Page>
      <h1 className="text-xl font-semibold">Translate a title</h1>
      <Card>
        <form onSubmit={translate} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              placeholder="The title of your video"
              className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Written in</span>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
              >
                <option value="auto">Detect automatically</option>
                {Object.keys(LANGS).map((c) => (
                  <option key={c} value={c}>
                    {langName(c)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={busy || !title.trim()} className="ml-auto">
              {busy ? "Translating..." : "Translate"}
            </Button>
          </div>
          <p className="text-xs text-neutral-500">
            Every title comes back in plain letters (no accents), at most {MAX_TITLE} characters. Languages with
            their own alphabet are written in Latin letters.
          </p>
        </form>
      </Card>

      {error && <Notice tone="bad">{error}</Notice>}

      {result && (
        <Card className="p-0">
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {codes.map((c) => (
              <Row key={c} code={c} text={result.titles[c]} original={c === result.source} />
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

function Row({ code, text, original }: { code: string; text: string; original: boolean }) {
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
        <div className="break-words">{text || <span className="text-neutral-400">No translation</span>}</div>
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
