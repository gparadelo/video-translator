import { Suspense } from "react";
import { workerOnline } from "@/lib/api";
import { getUser } from "@/lib/supabase/server";

// Placeholder until the real screens exist: proves sign-in and the database connection work.
export default function Home() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Video Translator</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <Jobs />
      </Suspense>
      <form action="/auth/signout" method="post">
        <button type="submit" className="underline">
          Sign out
        </button>
      </form>
    </main>
  );
}

async function Jobs() {
  const { supabase, user } = await getUser();
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, name, status, created_at")
    .order("created_at", { ascending: false });
  const { data: workers } = await supabase.from("workers").select("id, last_seen");

  return (
    <>
      <p className="text-sm">
        Signed in as {user?.email}. Worker: {workerOnline(workers) ? "online" : "offline"}.
      </p>
      <ul className="flex flex-col gap-1">
        {(jobs ?? []).map((j) => (
          <li key={j.id}>
            {j.name}: {j.status}
          </li>
        ))}
        {!jobs?.length && <li>No videos yet.</li>}
      </ul>
    </>
  );
}
