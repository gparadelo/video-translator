import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

// Why the last emailed link (confirm sign-up, reset password) didn't work, set by /auth/confirm (see its redirect).
const LINK_ERRORS: Record<string, string> = {
  other_browser:
    "That link was opened in a different browser from the one you used here. Sign in, or ask for a new link, and open it in this same browser.",
  expired: "That link has expired or was already used. Try signing in, or ask for a new one.",
  link: "That link didn't work. Try signing in, or ask for a new one.",
};

export default function LoginPage(props: PageProps<"/login">) {
  // The form is prerendered; only the ?error= message waits for the request.
  return (
    <Suspense fallback={<LoginForm linkError="" />}>
      <WithLinkError {...props} />
    </Suspense>
  );
}

async function WithLinkError({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  const key = typeof error === "string" ? error : undefined;
  return <LoginForm linkError={key ? (LINK_ERRORS[key] ?? LINK_ERRORS.link) : ""} />;
}
