"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Page } from "@/components/Header";
import { LanguagePicker } from "@/components/LanguagePicker";
import { TitleLanguage } from "@/components/Titles";
import { Button, Card, Notice } from "@/components/ui";
import Link from "next/link";
import { api, megabytes, type Job } from "@/lib/jobs";
import { checkVideo, type Check } from "@/lib/prepare/checks";
import { keepFile, measureKept } from "@/lib/prepare/files";
import { listOf, missingFor, toStatus, type SetupStatus } from "@/lib/setup";
import { createClient } from "@/lib/supabase/client";
import { MAX_TITLE } from "@/lib/titles";

type Created = { job: Job; upload: { url: string; headers: Record<string, string> } | null };

const field = "rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-base font-normal dark:border-neutral-700";

// New project: a video, a title, or both, and the languages to translate them into.
// A video is checked as soon as it's picked (lib/prepare/checks.ts): this browser must be able to read it, and the
// app must be able to make good translations of it. Then the project is created and we go to its page, which
// uploads the video and reads it at the same time (lib/prepare/files.ts); the title translates meanwhile.
export default function NewProject() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [titleLang, setTitleLang] = useState("auto");
  const [name, setName] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [reference, setReference] = useState("");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [check, setCheck] = useState<Check | "checking" | null>(null);

  // Start with the languages saved on the person's profile.
  useEffect(() => {
    createClient()
      .from("profiles")
      .select("languages")
      .maybeSingle()
      .then(({ data }) => data?.languages && setLanguages((cur) => (cur.length ? cur : data.languages)));
    createClient()
      .rpc("my_key_status")
      .then(({ data }) => setSetup(toStatus(data)));
  }, []);

  async function pick(f: File | null) {
    setFile(f);
    setCheck(f ? "checking" : null);
    if (!f) return;
    const c = await checkVideo(f).catch((e) => ({ ok: false as const, reason: `This video couldn't be checked: ${(e as Error).message}`, facts: null }));
    setFile((cur) => {
      if (cur === f) setCheck(c);
      return cur;
    });
  }

  // The name defaults to the video's file name, else the title.
  const fallbackName = file ? file.name.replace(/\.[^.]+$/, "") : title.trim().slice(0, 120);
  const projectName = name.trim() || fallbackName;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setStep("Creating the project…");
    try {
      const { job, upload } = await api<Created>("/api/jobs", {
        name: projectName,
        languages,
        title: title.trim() || undefined,
        title_lang: titleLang === "auto" ? undefined : titleLang,
        ...(file && { filename: file.name, bytes: file.size, reference }),
      });
      // If either part fails, the project page shows it and offers to try again.
      const titled = title.trim() ? api(`/api/jobs/${job.id}/title`, { missing: false }).catch(() => null) : null;
      if (file && upload) {
        // the project's page uploads it (and reads it meanwhile); the title keeps translating in the background
        keepFile(job.id, file);
        measureKept(job.id, true)?.catch(() => {});
      } else {
        setStep("Translating the title…");
        await titled;
      }
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError((err as Error).message);
      setStep("");
    }
  }

  const busy = step !== "";
  // Each person's projects run on their own keys and voice (Settings).
  const missing = missingFor(setup, { video: Boolean(file), title: Boolean(title.trim()) });
  const videoOk = !file || (check !== null && check !== "checking" && check.ok);
  const ready = (file || title.trim()) && projectName && languages.length > 0 && !missing.length && videoOk;
  return (
    <Page>
      <h1 className="text-xl font-semibold">New project</h1>
      <p className="-mt-3 text-sm text-neutral-500">Translate a video, a title, or both. Each part is optional.</p>
      <form onSubmit={start} className="flex flex-col gap-5">
        <Card className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <span>
              Video <span className="font-normal text-neutral-500">(optional)</span>
            </span>
            <input
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
              disabled={busy}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
              className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm font-normal file:mr-3 file:rounded-md file:border-0 file:bg-neutral-200 file:px-3 file:py-1.5 dark:border-neutral-700 dark:file:bg-neutral-700"
            />
            <span className="text-xs font-normal text-neutral-500">
              The finished video with its voiceover, as .mp4 or .mov, up to 5 GB and 10 minutes. Use Chrome or Edge on a
              computer: the video is read and its translations are made in this browser.
              {file && ` Selected: ${megabytes(file.size)}.`}
            </span>
          </label>
          {check === "checking" && <p className="text-sm text-neutral-500">Checking the video…</p>}
          {check && check !== "checking" && (check.ok ? (
            <div className="text-sm">
              <p className="text-emerald-700 dark:text-emerald-400">✓ {check.summary}</p>
              {check.notes.map((n) => <p key={n} className="text-xs text-neutral-500">{n}</p>)}
            </div>
          ) : (
            <Notice tone="bad">{check.reason}</Notice>
          ))}
          {file && (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <span>
                Names in the video <span className="font-normal text-neutral-500">(optional)</span>
              </span>
              <textarea
                value={reference}
                rows={2}
                disabled={busy}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Brand and product names as they are written, or the whole written script"
                className={`${field} text-sm`}
              />
              <span className="text-xs font-normal text-neutral-500">
                Helps get the spelling of names right in the transcript.
              </span>
            </label>
          )}
        </Card>

        <Card className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <span>
              Title <span className="font-normal text-neutral-500">(optional)</span>
            </span>
            <input
              value={title}
              maxLength={300}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="The title of your video"
              className={field}
            />
          </label>
          {title.trim() && <TitleLanguage value={titleLang} onChange={setTitleLang} disabled={busy} />}
          <p className="text-xs text-neutral-500">
            Translated into the same languages as the video: plain letters (no accents), at most {MAX_TITLE}{" "}
            characters, each with a Copy button.
          </p>
        </Card>

        <Card className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Translate into</h2>
          <LanguagePicker value={languages} onChange={setLanguages} />
          <p className="text-xs text-neutral-500">
            You can change these again before the video&apos;s translation starts.
          </p>
        </Card>

        <Card>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Project name
            <input
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder={fallbackName || "Named after the video or the title"}
              className={field}
            />
          </label>
        </Card>

        {missing.length > 0 && (
          <Notice tone="action">
            First add {listOf(missing)} in{" "}
            <Link href="/settings" className="underline">
              Settings
            </Link>
            .
          </Notice>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        {busy ? (
          <p className="text-sm text-neutral-500">{step} Keep this page open.</p>
        ) : (
          <Button type="submit" disabled={!ready} className="self-start">
            {file && title.trim() ? "Upload and translate" : file ? "Upload and transcribe" : "Translate title"}
          </Button>
        )}
      </form>
    </Page>
  );
}
