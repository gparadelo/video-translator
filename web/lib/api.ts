import { NextResponse } from "next/server";

export const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

export const MAX_BYTES = 5_000_000_000; // one signed upload: 5 GB

/**
 * Where a language's files live in R2: u/<user>/<job>/out/<lang>/<file> (plan.json, voice.wav, preview.mp4).
 * The worker (worker.py) and the database (save_preview) build the same keys.
 */
export const outputKey = (userId: string, jobId: string, lang: string, file: string) =>
  `u/${userId}/${jobId}/out/${lang}/${file}`;

export function extension(filename: string) {
  const m = /\.[a-z0-9]+$/i.exec(filename);
  return m ? m[0].toLowerCase() : "";
}
