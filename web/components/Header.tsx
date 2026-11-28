"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { STATUS, workerOnline, type Job, type Worker } from "@/lib/jobs";
import { createClient } from "@/lib/supabase/client";
import { usePoll } from "@/lib/use-poll";

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

type Project = Pick<Job, "id" | "name" | "status" | "has_video">;
type SidebarInfo = { online: boolean; email: string; projects: Project[] };

// Every page mounts its own sidebar, so keep the last answer around: moving between pages
// shows the list at once instead of blinking empty while it reloads.
let lastInfo: SidebarInfo | null = null;

const DOT = {
  idle: "bg-neutral-300 dark:bg-neutral-600",
  busy: "bg-blue-500",
  action: "bg-amber-500",
  good: "bg-emerald-500",
  bad: "bg-red-500",
};

const row =
  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-neutral-200/60 dark:hover:bg-neutral-800";
const rowActive = "bg-neutral-200/80 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100";

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

/** Left column on every signed-in screen: name, whether a renderer is on, your projects, and Settings at the bottom. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [supabase] = useState(createClient);
  const pathname = usePathname();
  const [polled, refresh] = usePoll(async () => {
    const [{ data: workers }, { data: auth }, { data: jobs, error }] = await Promise.all([
      supabase.from("workers").select("id, last_seen"),
      supabase.auth.getUser(),
      supabase.from("jobs").select("id, name, status, has_video").order("created_at", { ascending: false }),
    ]);
    if (error) throw error;
    lastInfo = {
      online: workerOnline(workers as Worker[] | null, Date.now()),
      email: auth.user?.email ?? "",
      projects: (jobs ?? []) as Project[],
    };
    return lastInfo;
  }, 10_000);
  const info = polled ?? lastInfo;

  // A project just made or renamed shows up as soon as you land on its page.
  useEffect(() => {
    refresh();
  }, [pathname, refresh]);

  return (
    <nav className="flex h-full flex-col gap-4 px-3 py-4">
      <div className="flex flex-col gap-2 px-2">
        <Link href="/" onClick={onNavigate} className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo />
          Video Translator
        </Link>
        <span className="flex h-4 items-center gap-1.5 text-xs text-neutral-500" title="The computer that renders the videos">
          {info && (
            <>
              <span className={`h-2 w-2 rounded-full ${info.online ? "bg-emerald-500" : "bg-neutral-400"}`} />
              {info.online ? "Renderer online" : "Renderer offline"}
            </>
          )}
        </span>
      </div>

      <Link
        href="/new"
        onClick={onNavigate}
        className={`${row} ${pathname === "/new" ? rowActive : "text-neutral-700 dark:text-neutral-300"}`}
      >
        <span aria-hidden className="grid h-4 w-4 place-items-center text-base leading-none">+</span>
        New project
      </Link>

      <div className="flex min-h-0 flex-1 flex-col">
        <Link
          href="/"
          onClick={onNavigate}
          className="px-2.5 pb-1 text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          Projects
        </Link>
        <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {info?.projects.length === 0 && <li className="px-2.5 py-1.5 text-sm text-neutral-500">No projects yet</li>}
          {info?.projects.map((p) => {
            const active = pathname === `/jobs/${p.id}`;
            return (
              <li key={p.id}>
                <Link
                  href={`/jobs/${p.id}`}
                  onClick={onNavigate}
                  title={p.has_video ? `${p.name} · ${STATUS[p.status].label}` : `${p.name} · Title only`}
                  className={`${row} ${active ? rowActive : "text-neutral-700 dark:text-neutral-300"}`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.has_video ? DOT[STATUS[p.status].tone] : DOT.idle}`} />
                  <span className="min-w-0 truncate">{p.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-neutral-200/80 pt-3 dark:border-neutral-800">
        <Link
          href="/settings"
          onClick={onNavigate}
          className={`${row} ${pathname === "/settings" ? rowActive : "text-neutral-700 dark:text-neutral-300"}`}
        >
          <GearIcon />
          Settings
        </Link>
        <form action="/auth/signout" method="post" className="flex items-center gap-2 px-2.5 pt-1">
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{info?.email}</span>
          <button type="submit" className="shrink-0 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}

export function Page({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-neutral-200/80 bg-neutral-100/70 md:block dark:border-neutral-800 dark:bg-neutral-950">
        <Sidebar />
      </aside>

      {/* Small screens: the sidebar slides in over the page from a menu button. */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="fixed top-3 left-3 z-20 grid h-9 w-9 place-items-center rounded-lg border border-neutral-200/80 bg-surface shadow-sm md:hidden dark:border-neutral-800"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-30 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85%] bg-neutral-100 shadow-xl dark:bg-neutral-950">
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-5 pt-16 pb-8 md:py-10">{children}</main>
    </div>
  );
}
