"use client";

import Link from "next/link";
import { useState } from "react";
import { Page } from "@/components/Header";
import { Button, Card, Notice, PageTitle } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

const field = "rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-base font-normal dark:border-neutral-700";

// Choose a new password. The reset email's link signs the person in and lands here; it's also where a
// signed-in person changes their password (linked from Settings).
export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await createClient().auth.updateUser({ password });
    setBusy(false);
    if (error)
      setError(
        error.code === "same_password"
          ? "That's already your password. Choose a different one."
          : `That didn't work: ${error.message}`,
      );
    else setDone(true);
  }

  return (
    <Page>
      <PageTitle>Choose a new password</PageTitle>
      <Card className="flex flex-col gap-4">
        {done ? (
          <>
            <Notice tone="idle">Your password is saved. Use it next time you sign in.</Notice>
            <Link href="/" className="self-start text-sm underline">
              Go to your projects
            </Link>
          </>
        ) : (
          <form onSubmit={save} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              New password
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={field}
              />
              <span className="text-xs font-normal text-neutral-500">At least 8 characters.</span>
            </label>
            <Button type="submit" disabled={busy} className="self-start">
              {busy ? "Saving…" : "Save password"}
            </Button>
            {error && <Notice tone="bad">{error}</Notice>}
          </form>
        )}
      </Card>
    </Page>
  );
}
