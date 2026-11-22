"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Top bar on every signed-in screen: name and who you are. */
export function Header() {
  const [supabase] = useState(createClient);
  const [info, setInfo] = useState<{ email: string } | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setInfo({ email: data.user?.email ?? "" }));
  }, [supabase]);

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <Link href="/" className="font-semibold">
          Video Translator
        </Link>
        <form action="/auth/signout" method="post" className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
          <span className="hidden sm:inline">{info?.email}</span>
          <Link href="/settings" className="underline">
            Settings
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
