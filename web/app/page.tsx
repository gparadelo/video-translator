"use client";

import Link from "next/link";
import { useState } from "react";
import { Page } from "@/components/Header";
import { buttonClass, Card, Notice, PageTitle, Pill, StatusPill } from "@/components/ui";
import { langName, type Job } from "@/lib/jobs";
import { listOf, missingFor, toStatus } from "@/lib/setup";
import { createClient } from "@/lib/supabase/client";
import { usePoll } from "@/lib/use-poll";

// Home: your projects (a video, a title, or both), newest first, with where each one stands.
export default function Home() {
  const [supabase] = useState(createClient);
  const [jobs] = usePoll(async () => {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, name, status, languages, created_at, has_video, title")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data as Pick<Job, "id" | "name" | "status" | "languages" | "created_at" | "has_video" | "title">[];
  }, 8000);
  const [setup] = usePoll(async () => toStatus((await supabase.rpc("my_key_status")).data), 60_000);
  const missing = missingFor(setup, { video: true, title: true });

  return (
    <Page>
      <div className="flex items-center justify-between">
        <PageTitle>Your projects</PageTitle>
        <Link href="/new" className={buttonClass()}>
          <span aria-hidden className="-ml-0.5 text-base leading-none">+</span>
          New project
        </Link>
      </div>

      {missing.length > 0 && (
        <Notice tone="action">
          Before your first project, add {listOf(missing)} in{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>
          . Your projects use your own ElevenLabs and Claude accounts.
        </Notice>
      )}

      {jobs === null && <p className="text-sm text-neutral-500">Loading…</p>}
      {jobs?.length === 0 && (
        <Card className="border-dashed py-10 text-center text-sm text-neutral-500 shadow-none">
          Nothing here yet. Start a project to translate a video, a title, or both.
        </Card>
      )}
      <ul className="flex flex-col gap-2">
        {jobs?.map((j) => (
          <li key={j.id}>
            <Link
              href={`/jobs/${j.id}`}
              className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200/80 bg-surface px-4 py-3.5 shadow-sm transition hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-neutral-800 dark:shadow-none dark:hover:border-neutral-700"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{j.name}</span>
                <span className="block truncate text-xs text-neutral-500">
                  {new Date(j.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  {j.languages.length > 0 && ` · ${j.languages.map(langName).join(", ")}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {j.title && <Pill tone="idle">{j.has_video ? "+ Title" : "Title only"}</Pill>}
                {j.has_video && <StatusPill status={j.status} />}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
