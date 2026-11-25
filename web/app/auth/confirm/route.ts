import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Where the links in Supabase's emails land (confirm sign-up, reset password). Supabase sends either
// ?code=... (default) or ?token_hash=...&type=... (when the email template is customised); both sign the
// person in. ?next= says where to go afterwards (the reset link uses /reset-password).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next");
  const to = next?.startsWith("/") && !next.startsWith("//") ? next : type === "recovery" ? "/reset-password" : "/";
  const supabase = await createClient();

  let error: { code?: string; message: string } | null = { message: "missing code" };
  if (code) ({ error } = await supabase.auth.exchangeCodeForSession(code));
  else if (tokenHash && type) ({ error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash }));
  if (!error) return NextResponse.redirect(`${origin}${to}`);

  // A ?code= link only works in the browser that asked for it: that browser holds the matching
  // secret (PKCE) in a cookie. Opening it from a mail app's own browser, or another device, fails.
  console.error("sign-in link failed:", error.code, error.message);
  const reason = /code verifier|code_verifier/i.test(error.message) || error.code === "bad_code_verifier"
    ? "other_browser"
    : /expired|invalid|already/i.test(error.message) || error.code === "otp_expired" || error.code === "flow_state_not_found"
      ? "expired"
      : "link";
  return NextResponse.redirect(`${origin}/login?error=${reason}`);
}
