import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Supabase client for server code, acting as the signed-in person (row-level security applies). */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
          } catch {
            // Server Components can't set cookies; proxy.ts refreshes the session instead.
          }
        },
      },
    },
  );
}

/** The signed-in person, or null. Checked with Supabase, not just read from the cookie. */
export async function getUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}
