"use client";

import Link from "next/link";
import { useState } from "react";
import { workerOnline, type Worker } from "@/lib/jobs";
import { createClient } from "@/lib/supabase/client";
import { usePoll } from "@/lib/use-poll";

/** Top bar on every signed-in screen: name, whether the render Mac is on, who you are. */
export function Header() {
  const [supabase] = useState(createClient);
  const [info] = usePoll(async () => {
    const [{ data: workers }, { data: auth }] = await Promise.all([
      supabase.from("workers").select("id, last_seen"),
      supabase.auth.getUser(),
    ]);
    return { online: workerOnline(workers as Worker[] | null, Date.now()), email: auth.user?.email ?? "" };
  }, 10_000);

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <Link href="/" className="font-semibold">
          Video Translator
        </Link>
        {info && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-500" title="The Mac that renders the videos">
            <span className={`h-2 w-2 rounded-full ${info.online ? "bg-emerald-500" : "bg-neutral-400"}`} />
            {info.online ? "Render Mac online" : "Render Mac offline"}
          </span>
        )}
        <form action="/auth/signout" method="post" className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
          <span className="hidden sm:inline">{info?.email}</span>
          <Link href="/settings" className="underline">
            Settings
          </Link>
          <Link href="/reset-password" className="underline">
            Password
          </Link>
          <button type="submit" className="underline">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6">{children}</main>
    </>
  );
}
