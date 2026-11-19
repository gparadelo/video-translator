import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Runs before every page: keeps the login session fresh and sends signed-out people to /login.
// API routes check the session themselves and answer 401.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
        },
      },
    },
  );
  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  // Supabase sends the link to the Site URL instead of /auth/confirm when the redirect address isn't
  // on its allow list. Pass the code on rather than dropping it on the way to /login.
  const code = request.nextUrl.searchParams.get("code");
  if (code && !path.startsWith("/auth") && !path.startsWith("/api")) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/confirm";
    url.search = `?code=${encodeURIComponent(code)}`;
    return NextResponse.redirect(url);
  }
  const open = path.startsWith("/login") || path.startsWith("/auth") || path.startsWith("/api");
  if (!data?.claims && !open) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
