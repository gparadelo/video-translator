"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup" | "forgot";

const TITLES: Record<Mode, string> = { signin: "Sign in", signup: "Create an account", forgot: "Reset your password" };
const BUTTONS: Record<Mode, [idle: string, busy: string]> = {
  signin: ["Sign in", "Signing in…"],
  signup: ["Create account", "Creating…"],
  forgot: ["Email me a reset link", "Sending…"],
};

export function LoginForm({ linkError }: { linkError: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(linkError);
  const [sent, setSent] = useState(""); // what we emailed, once we have

  function switchTo(next: Mode) {
    setMode(next);
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const auth = createClient().auth;
    const origin = window.location.origin;
    try {
      if (mode === "signin") {
        const { error } = await auth.signInWithPassword({ email, password });
        if (error) return setError(authError(error));
        router.replace("/");
        router.refresh();
      } else if (mode === "signup") {
        const { data, error } = await auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${origin}/auth/confirm` },
        });
        if (error) return setError(authError(error));
        // With "Confirm email" off in Supabase the account is ready now; with it on, they confirm first.
        if (data.session) {
          router.replace("/");
          router.refresh();
        } else setSent(`We sent a confirmation link to ${email}. Open it in this browser to finish signing up.`);
      } else {
        const { error } = await auth.resetPasswordForEmail(email, {
          redirectTo: `${origin}/auth/confirm?next=/reset-password`,
        });
        if (error) return setError(authError(error));
        setSent(`If ${email} has an account, we sent it a link to choose a new password. Open it in this browser.`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Video Translator</h1>
        <p className="mt-1 text-sm text-neutral-500">{TITLES[mode]}</p>
      </div>
      {sent ? (
        <div className="flex flex-col gap-3">
          <p>{sent}</p>
          <button type="button" className="self-start text-sm underline" onClick={() => (setSent(""), switchTo("signin"))}>
            Back to sign in
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded border border-neutral-400 bg-transparent px-3 py-2 text-base"
            />
          </label>
          {mode !== "forgot" && (
            <label className="flex flex-col gap-1 text-sm">
              Password
              <input
                type="password"
                required
                minLength={mode === "signup" ? 8 : undefined}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded border border-neutral-400 bg-transparent px-3 py-2 text-base"
              />
              {mode === "signup" && <span className="text-xs text-neutral-500">At least 8 characters.</span>}
            </label>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {BUTTONS[mode][busy ? 1 : 0]}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-col gap-1 text-sm text-neutral-600 dark:text-neutral-400">
            {mode === "signin" && (
              <>
                <p>
                  New here?{" "}
                  <button type="button" className="underline" onClick={() => switchTo("signup")}>
                    Create an account
                  </button>
                </p>
                <button type="button" className="self-start underline" onClick={() => switchTo("forgot")}>
                  Forgot your password?
                </button>
              </>
            )}
            {mode !== "signin" && (
              <p>
                {mode === "signup" ? "Already have an account? " : ""}
                <button type="button" className="underline" onClick={() => switchTo("signin")}>
                  {mode === "signup" ? "Sign in" : "Back to sign in"}
                </button>
              </p>
            )}
          </div>
        </form>
      )}
    </main>
  );
}

/** What to tell the person when Supabase says no. */
function authError(error: { status?: number; code?: string; message: string }): string {
  if (error.code === "invalid_credentials" || /invalid login credentials/i.test(error.message))
    return "Wrong email or password. If you used to sign in with an email link, use “Forgot your password?” to set one.";
  if (error.code === "email_not_confirmed") return "Confirm your email first: open the link we sent when you signed up.";
  if (error.code === "user_already_exists" || /already registered/i.test(error.message))
    return "There's already an account with that email. Sign in instead.";
  if (error.code === "weak_password") return `Choose a stronger password: ${error.message}`;
  if (error.code === "signup_disabled" || /signups not allowed/i.test(error.message))
    return "Sign-ups are turned off right now.";
  if (error.status === 429 || /rate limit|seconds/i.test(error.message))
    return "Too many tries or emails just now. Wait a minute and try again.";
  return `That didn't work: ${error.message}`;
}
