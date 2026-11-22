// Shared by the screens (browser side): what a job (a project: a video, a title, or both) looks like, and
// the words we show for it.

export type Progress = { stage?: string; lang?: string; done?: number; total?: number };

export type Job = {
  id: string;
  name: string;
  // queued/preparing and approved/aligning are the worker's (transcribing, timing an edited transcript);
  // producing is this app's: the job page makes each language (lib/produce)
  status: "uploading" | "queued" | "preparing" | "needs_review" | "approved" | "aligning" | "producing" | "done" | "failed" | "canceled";
  languages: string[];
  base_lang: string | null;
  script: string | null;
  names_fixed: string[];
  warnings: string[];
  progress: Progress | null;
  error: string | null;
  source_filename: string | null;
  source_bytes: number | null;
  created_at: string;
  has_video: boolean;
  title: string | null;
  title_lang: string | null;
  titles: Record<string, string>; // includes title_lang: the original, cleaned to the same rules
};

export type Output = {
  lang: string;
  // pending: asked for, the job page starts a run; running: the job page is making it (lib/produce).
  // voiced: the voice is recorded (inputs_key); the browser builds the plan and the voice track
  // (lib/pipeline). ready: plan and voice track are there; the browser renders the video (lib/render).
  // done: rendered by an older worker (output_key is the full video). failed: flags[0] says why.
  status: "pending" | "running" | "voiced" | "ready" | "done" | "failed";
  /** the run of this language the files belong to; a new translation starts a new one */
  generation: number;
  inputs_key: string | null;
  seconds: number | null;
  flags: string[];
  output_key: string | null;
  output_bytes: number | null;
  preview_key: string | null; // the 720p preview, made by the browser (or by an older worker)
  preview_bytes: number | null;
  plan_key: string | null;
  voice_key: string | null;
};

export type Worker = { id: string; last_seen: string };

export const LANGS: Record<string, string> = {
  en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian", nl: "Dutch", pt: "Portuguese",
  pl: "Polish", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", tr: "Turkish", ja: "Japanese",
  ko: "Korean", zh: "Chinese", ar: "Arabic", hi: "Hindi", ru: "Russian", uk: "Ukrainian", cs: "Czech",
  ro: "Romanian", el: "Greek", hu: "Hungarian", ca: "Catalan",
};
export const COMMON_LANGS = ["en", "es", "de", "fr", "it", "nl", "pt"];
export const langName = (code: string) => LANGS[code] ?? code.toUpperCase();

export const STATUS: Record<Job["status"], { label: string; tone: "idle" | "busy" | "action" | "good" | "bad" }> = {
  uploading: { label: "Upload not finished", tone: "action" },
  queued: { label: "Waiting to start", tone: "idle" },
  preparing: { label: "Transcribing", tone: "busy" },
  needs_review: { label: "Ready for your review", tone: "action" },
  approved: { label: "Waiting to start", tone: "idle" },
  aligning: { label: "Getting ready", tone: "busy" },
  producing: { label: "Translating", tone: "busy" },
  done: { label: "Ready", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  canceled: { label: "Canceled", tone: "idle" },
};

const STAGES: Record<string, string> = {
  download: "Downloading the video",
  transcribe: "Transcribing the voiceover",
  align: "Timing each word",
  analyze: "Analyzing the video",
  prepared: "Almost ready",
  translate: "Translating",
  rewrite: "Adjusting the translation to fit",
  tts: "Recording the voice",
  plan: "Fitting the video to the voice",
  voice: "Mixing the voice",
  render: "Rendering the video",
  preview: "Making the preview",
  upload: "Uploading the result",
};

/** "Rendering the video · 12 of 34" or "Uploading the result · 40%". */
export function progressText(p: Progress | null) {
  if (!p?.stage) return null;
  const label = STAGES[p.stage] ?? "Working";
  if (!p.total || p.done == null) return label;
  const bytes = p.stage === "upload" || p.stage === "download";
  return `${label} · ${bytes ? `${Math.round((100 * p.done) / p.total)}%` : `${p.done} of ${p.total}`}`;
}

/** The worker checks in every 10-30 seconds; silent for 90 means it's off. */
export const workerOnline = (workers: Worker[] | null, now: number) =>
  (workers ?? []).some((w) => now - new Date(w.last_seen).getTime() < 90_000);

export const megabytes = (bytes: number | null) => (bytes ? `${Math.round(bytes / 1e6)} MB` : "");

export const splitBeats = (script: string) =>
  script.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

/** Upload a file straight to storage with the signed link from the server. */
export function uploadVideo(
  file: Blob,
  upload: { url: string; headers: Record<string, string> },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", upload.url);
    for (const [k, v] of Object.entries(upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`storage answered ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("the connection dropped"));
    xhr.onabort = () => reject(new DOMException("stopped", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Call one of our own /api routes and return its JSON, or throw its error message. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `something went wrong (${r.status})`);
  return data as T;
}
