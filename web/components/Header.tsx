"use client";

import Link from "next/link";
import { useState } from "react";
import { workerOnline, type Worker } from "@/lib/jobs";
import { createClient } from "@/lib/supabase/client";
import { usePoll } from "@/lib/use-poll";

const navLink =
  "rounded-md px-2 py-1 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

/** The app's mark: a small speech bubble. */
export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-lg bg-accent text-white ${className}`} aria-hidden>
      <svg viewBox="0 0 24 24" className="h-[60%] w-[60%]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 5h16v11H9l-5 4z" />
        <path d="M9 10.5h6" />
      </svg>
    </span>
  );
}

/** Top bar on every signed-in screen: name, whether a renderer is on, who you are. */
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
    <header className="sticky top-0 z-10 border-b border-neutral-200/80 bg-surface/80 backdrop-blur dark:border-neutral-800">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo />
          Video Translator
        </Link>
        {info && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-500" title="The computer that renders the videos">
            <span className={`h-2 w-2 rounded-full ${info.online ? "bg-emerald-500" : "bg-neutral-400"}`} />
            {info.online ? "Renderer online" : "Renderer offline"}
          </span>
        )}
        <form action="/auth/signout" method="post" className="ml-auto flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="mr-2 hidden text-xs text-neutral-500 sm:inline">{info?.email}</span>
          <Link href="/settings" className={navLink}>
            Settings
          </Link>
          <Link href="/reset-password" className={navLink}>
            Password
          </Link>
          <button type="submit" className={navLink}>
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
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-8">{children}</main>
    </>
  );
}
