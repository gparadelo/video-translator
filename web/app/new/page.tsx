"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Page } from "@/components/Header";
import { LanguagePicker } from "@/components/LanguagePicker";
import { Bar, Button, Card, Notice } from "@/components/ui";
import { api, megabytes, uploadVideo, type Job } from "@/lib/jobs";
import { createClient } from "@/lib/supabase/client";

type Created = { job: Job; upload: { url: string; headers: Record<string, string> } };

// New video: pick the file and the languages, upload, and go to the video's page.
export default function NewVideo() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [reference, setReference] = useState("");
  const [fraction, setFraction] = useState<number | null>(null);
  const [error, setError] = useState("");

  // Start with the languages saved on the person's profile.
  useEffect(() => {
    createClient()
      .from("profiles")
      .select("languages")
      .maybeSingle()
      .then(({ data }) => data?.languages && setLanguages((cur) => (cur.length ? cur : data.languages)));
  }, []);

  function choose(f: File | null) {
    setFile(f);
    if (f && !name) setName(f.name.replace(/\.[^.]+$/, ""));
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError("");
    setFraction(0);
    try {
      const { job, upload } = await api<Created>("/api/jobs", {
        name,
        filename: file.name,
        bytes: file.size,
        languages,
        reference,
      });
      try {
        await uploadVideo(file, upload, setFraction);
        await api(`/api/jobs/${job.id}/submit`);
      } finally {
        router.push(`/jobs/${job.id}`); // if the upload failed, that page offers to try again
      }
    } catch (err) {
      setError((err as Error).message);
      setFraction(null);
    }
  }

  const busy = fraction !== null;
  return (
    <Page>
      <h1 className="text-xl font-semibold">New video</h1>
      <form onSubmit={start} className="flex flex-col gap-5">
        <Card className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Video
            <input
              type="file"
              accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
              required
              disabled={busy}
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
              className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm font-normal file:mr-3 file:rounded-md file:border-0 file:bg-neutral-200 file:px-3 file:py-1.5 dark:border-neutral-700 dark:file:bg-neutral-700"
            />
            <span className="text-xs font-normal text-neutral-500">
              The finished video with its voiceover, as .mp4 or .mov, up to 5 GB.
              {file && ` Selected: ${megabytes(file.size)}.`}
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <input
              value={name}
              required
              maxLength={120}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-base font-normal dark:border-neutral-700"
            />
          </label>
        </Card>

        <Card className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Translate into</h2>
          <LanguagePicker value={languages} onChange={setLanguages} />
          <p className="text-xs text-neutral-500">You can change these again before the translation starts.</p>
        </Card>

        <Card className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Names in the video <span className="font-normal text-neutral-500">(optional)</span>
            <textarea
              value={reference}
              rows={2}
              disabled={busy}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Brand and product names as they are written, or the whole written script"
              className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm font-normal dark:border-neutral-700"
            />
          </label>
          <p className="text-xs text-neutral-500">Helps get the spelling of names right in the transcript.</p>
        </Card>

        {error && <Notice tone="bad">{error}</Notice>}
        {busy ? (
          <div className="flex flex-col gap-2">
            <Bar fraction={fraction} />
            <p className="text-sm text-neutral-500">Uploading… {Math.round(fraction * 100)}%. Keep this page open.</p>
          </div>
        ) : (
          <Button type="submit" disabled={!file || !name.trim() || languages.length === 0} className="self-start">
            Upload and transcribe
          </Button>
        )}
      </form>
    </Page>
  );
}
