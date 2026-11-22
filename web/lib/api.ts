import { NextResponse } from "next/server";

export const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

export const MAX_BYTES = 5_000_000_000; // one signed upload: 5 GB

/**
 * Where one run (generation) of a language keeps its files in R2: u/<user>/<job>/out/<lang>/g<generation>/<file>
 * (inputs.json, tts/<clip>, plan.json, voice.wav, preview.mp4). The worker (worker.py) and the database
 * (worker_output, save_plan, save_preview) build the same keys. See "Files in storage" in docs/web-setup.md.
 */
export const outputKey = (userId: string, jobId: string, lang: string, generation: number, file: string) =>
  `u/${userId}/${jobId}/out/${lang}/g${generation}/${file}`;

/** The run of a language a request is about, as the page read it from job_outputs.generation. */
export const generationOf = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : null);

export function extension(filename: string) {
  const m = /\.[a-z0-9]+$/i.exec(filename);
  return m ? m[0].toLowerCase() : "";
}
