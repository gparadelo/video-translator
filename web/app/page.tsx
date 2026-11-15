"use client";

import Link from "next/link";
import { useState } from "react";
import { Page } from "@/components/Header";
import { Card, StatusPill } from "@/components/ui";
import { langName, type Job } from "@/lib/jobs";
import { createClient } from "@/lib/supabase/client";
import { usePoll } from "@/lib/use-poll";

// Home: your videos, newest first, with where each one stands.
export default function Home() {
  const [supabase] = useState(createClient);
  const [jobs] = usePoll(async () => {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, name, status, languages, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data as Pick<Job, "id" | "name" | "status" | "languages" | "created_at">[];
  }, 8000);

  return (
    <Page>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Your videos</h1>
        <Link
          href="/new"
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          New video
        </Link>
      </div>

      {jobs === null && <p className="text-sm text-neutral-500">Loading…</p>}
      {jobs?.length === 0 && (
        <Card className="text-sm text-neutral-500">Nothing here yet. Upload a video to translate it.</Card>
      )}
      <ul className="flex flex-col gap-2">
        {jobs?.map((j) => (
          <li key={j.id}>
            <Link
              href={`/jobs/${j.id}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{j.name}</span>
                <span className="block truncate text-xs text-neutral-500">
                  {new Date(j.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  {j.languages.length > 0 && ` · ${j.languages.map(langName).join(", ")}`}
                </span>
              </span>
              <StatusPill status={j.status} />
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
