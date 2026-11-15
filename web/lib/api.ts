import { NextResponse } from "next/server";

export const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

export const MAX_BYTES = 5_000_000_000; // one signed upload: 5 GB

export function extension(filename: string) {
  const m = /\.[a-z0-9]+$/i.exec(filename);
  return m ? m[0].toLowerCase() : "";
}

/** A worker counts as online when it checked in during the last 90 seconds (it does so every 30). */
export function workerOnline(workers: { last_seen: string }[] | null) {
  return (workers ?? []).some((w) => Date.now() - new Date(w.last_seen).getTime() < 90_000);
}
