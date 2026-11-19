import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

// Why the last sign-in link didn't work, set by /auth/confirm (see its redirect).
const LINK_ERRORS: Record<string, string> = {
  other_browser:
    "That link was opened in a different browser from the one you requested it in. Request a new link here and open it in this same browser.",
  expired: "That sign-in link has expired or was already used. Request a new one.",
  link: "That sign-in link didn't work. Request a new one.",
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
