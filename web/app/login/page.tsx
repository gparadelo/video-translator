"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm`, shouldCreateUser: false },
    });
    setState(error ? "error" : "sent");
    setMessage(error ? "That didn't work. Check the address, or ask for access." : "");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Video Translator</h1>
      {state === "sent" ? (
        <p>Check your email: we sent a sign-in link to {email}.</p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded border border-neutral-400 bg-transparent px-3 py-2 text-base"
            />
          </label>
          <button
            type="submit"
            disabled={state === "sending"}
            className="rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {state === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
          {message && <p className="text-sm text-red-600">{message}</p>}
        </form>
      )}
    </main>
  );
}
