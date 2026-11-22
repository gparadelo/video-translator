// The video a person just picked, kept in this tab (moving between the app's pages keeps it): the new-project page
// hands it to the project's page, which uploads it and measures it at the same time (lib/prepare/local.ts), so
// nothing has to be read back from storage. Each runs once per project, whichever component asks; anyone can
// follow its progress. After a reload the file is gone: the page then asks for it again (upload) or reads the
// upload from storage (measure). Browser only.

import { api, uploadVideo } from "../jobs";
import type { Measured, MeasureProgress } from "./local";

type Task<T> = { promise: Promise<T>; progress: number; listeners: Set<(f: number) => void> };
type Kept = { file: File; upload?: Task<void>; measure?: Task<Measured> & { full: boolean; stage: MeasureProgress["stage"] } };

const kept = new Map<string, Kept>();

export const keepFile = (jobId: string, file: File) => void kept.set(jobId, { file });
export const keptFile = (jobId: string): File | null => kept.get(jobId)?.file ?? null;

function task<T>(run: (progress: (f: number) => void) => Promise<T>): Task<T> {
  const t: Task<T> = { promise: Promise.resolve() as Promise<T>, progress: 0, listeners: new Set() };
  t.promise = run((f) => {
    t.progress = f;
    t.listeners.forEach((l) => l(f));
  });
  return t;
}

/** Follow a task's progress; returns how to stop following. */
const follow = (t: Task<unknown> | undefined, fn: (f: number) => void) => {
  if (!t) return () => {};
  fn(t.progress);
  t.listeners.add(fn);
  return () => void t.listeners.delete(fn);
};

/**
 * Upload the kept video with a fresh link and tell the server it arrived (submit): once per project. A failure
 * can be tried again (the next call starts over).
 */
export function uploadKept(jobId: string, onProgress: (f: number) => void): Promise<void> | null {
  const k = kept.get(jobId);
  if (!k) return null;
  if (!k.upload) {
    const t = task(async (progress) => {
      const { upload } = await api<{ upload: { url: string; headers: Record<string, string> } }>(`/api/jobs/${jobId}/upload-url`);
      await uploadVideo(k.file, upload, progress);
      await api(`/api/jobs/${jobId}/submit`);
    });
    t.promise.catch(() => {
      if (k.upload === t) k.upload = undefined; // the next try starts again
    });
    k.upload = t;
  }
  const stop = follow(k.upload, onProgress);
  return k.upload.promise.finally(stop);
}

/**
 * Measure the kept video (measureVideo): once per project, started as soon as the project exists, so it runs while
 * the video uploads. `full` false: only the voiceover. Returns null without a kept file.
 */
export function measureKept(jobId: string, full: boolean, onProgress?: (p: MeasureProgress) => void, signal?: AbortSignal): Promise<Measured> | null {
  const k = kept.get(jobId);
  if (!k) return null;
  if (!k.measure || (full && !k.measure.full)) {
    let stage: MeasureProgress["stage"] = "sound";
    const t = task(async (progress) => {
      const { measureVideo } = await import("./local");
      return measureVideo(k.file, full, (p) => {
        stage = p.stage;
        if (k.measure) k.measure.stage = p.stage;
        progress(p.fraction);
      });
    });
    const m = Object.assign(t, { full, stage });
    m.promise.catch(() => {
      if (k.measure === m) k.measure = undefined;
    });
    k.measure = m;
  }
  const m = k.measure;
  const stop = follow(m, (fraction) => onProgress?.({ stage: m.stage, fraction }));
  // stopping only stops following: the measuring goes on for whoever asks next
  return new Promise<Measured>((resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("stopped", "AbortError")), { once: true });
    m.promise.then(resolve, reject).finally(stop);
  });
}
