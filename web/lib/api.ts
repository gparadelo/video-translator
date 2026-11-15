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
