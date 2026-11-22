// What the job page does with a language that is ready to render: check the browser, make the preview
// (rendered here, uploaded so it plays on the page), measure how fast each quality would be, and render the
// full-quality download (saved on this computer, never uploaded). Browser only; load it with import().

import { BufferTarget } from "mediabunny";
import { api, uploadVideo } from "@/lib/jobs";
import { parsePlan, type RenderPlan } from "./plan";
import { pickQuality, previewQuality, qualityOptions, type Quality, type QualityId } from "./quality";
import { canEncodeVoice, findEncoder, measureSpeed, missingApis, openSource, renderPlan, type Encoder, type Source } from "./render";
import { cleanUpTemporaryFiles, type SaveTarget } from "./save";
import { parseWav, type Pcm } from "./wav";

export const UNSUPPORTED = "This browser can't make the videos. Use Chrome or Edge on a computer.";

export type Stage = "loading" | "rendering" | "uploading";
export type Progress = { stage: Stage; fraction: number };

/** null when this browser can render (preview and audio); otherwise the message to show. */
export async function checkBrowser(): Promise<string | null> {
  if (missingApis()) return UNSUPPORTED;
  if (!(await canEncodeVoice())) return UNSUPPORTED;
  if (!(await findEncoder({ id: "720p", width: 720, height: 1280, bitrate: 2_000_000 }, ["avc"])))
    return UNSUPPORTED;
  return null;
}

type Links = { name: string; source: string; plan: string; voice: string };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `couldn't load the files (${r.status})`);
  return data as T;
}

async function fetchOk(url: string, what: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`couldn't download the ${what} (${r.status})`);
  return r;
}

type Loaded = { name: string; plan: RenderPlan; source: Source; voice: Pcm | null };

async function load(jobId: string, lang: string, withVoice: boolean): Promise<Loaded> {
  const links = await getJson<Links>(`/api/jobs/${jobId}/render/${lang}`);
  const [plan, voice] = await Promise.all([
    fetchOk(links.plan, "plan").then((r) => r.json()).then(parsePlan),
    withVoice ? fetchOk(links.voice, "voice").then((r) => r.arrayBuffer()).then(parseWav) : null,
  ]);
  const source = await openSource(links.source);
  return { name: links.name, plan, source, voice };
}

/** Render the 720p preview and upload it. The page shows it once this resolves. */
export async function makePreview(jobId: string, lang: string, onProgress: (p: Progress) => void, signal: AbortSignal) {
  onProgress({ stage: "loading", fraction: 0 });
  const job = await load(jobId, lang, true);
  try {
    const q = previewQuality(job.source.width, job.source.height);
    const encoder = await findEncoder(q, ["avc"]); // H.264: plays in every browser
    if (!encoder) throw new Error(UNSUPPORTED);
    const target = new BufferTarget(); // small enough for memory; "in-memory" puts the index first, so it streams
    await renderPlan({
      source: job.source, plan: job.plan, voice: job.voice!, encoder, target, fastStart: "in-memory", signal,
      onProgress: (p) => onProgress({ stage: "rendering", fraction: p.done / p.total }),
    });
    const blob = new Blob([target.buffer!], { type: "video/mp4" });
    onProgress({ stage: "uploading", fraction: 0 });
    const { upload } = await api<{ upload: { url: string; headers: Record<string, string> } }>(
      `/api/jobs/${jobId}/preview/${lang}`, { bytes: blob.size });
    await uploadVideo(blob, upload, (f) => onProgress({ stage: "uploading", fraction: f }), signal);
    await api(`/api/jobs/${jobId}/preview/${lang}`, { bytes: blob.size, done: true });
  } finally {
    job.source.dispose();
  }
}

export type Choice = { quality: Quality; encoder: Encoder; seconds: number | null };

// The same source for every language of a job, so its speed is measured once per job (seconds per frame).
const speeds = new Map<string, Promise<Partial<Record<QualityId, number>>>>();

/**
 * The qualities this browser can make for this language, each with an estimated render time from a short
 * test encode, and the one to preselect.
 */
export async function measureChoices(jobId: string, lang: string): Promise<{ choices: Choice[]; pick: QualityId }> {
  const job = await load(jobId, lang, false);
  try {
    const options = qualityOptions(job.source.width, job.source.height);
    const encoders = await Promise.all(options.map((q) => findEncoder(q)));
    const usable = options.flatMap((quality, i) => (encoders[i] ? [{ quality, encoder: encoders[i]! }] : []));
    if (!usable.length) throw new Error(UNSUPPORTED);
    if (!speeds.has(jobId)) {
      speeds.set(jobId, measureSpeed(job.source, usable.map((u) => u.encoder)).then(
        (s) => Object.fromEntries(usable.map((u, i) => [u.quality.id, s[i]])),
        () => ({}), // no estimate is fine: the choice still works
      ));
    }
    const perFrame = await speeds.get(jobId)!;
    // decoding and muxing add a little to the measured encode
    const choices = usable.map((u) => {
      const s = perFrame[u.quality.id];
      return { ...u, seconds: s != null && Number.isFinite(s) ? s * job.plan.total_frames * 1.15 + 3 : null };
    });
    const estimates = Object.fromEntries(choices.filter((c) => c.seconds != null).map((c) => [c.quality.id, c.seconds!]));
    return { choices, pick: pickQuality(choices.map((c) => c.quality), estimates) };
  } finally {
    job.source.dispose();
  }
}

/** Render the full-quality video into `save` (a file on this computer). */
export async function renderDownload(jobId: string, lang: string, choice: Choice, save: SaveTarget,
                                     onProgress: (p: Progress) => void, signal: AbortSignal) {
  onProgress({ stage: "loading", fraction: 0 });
  await cleanUpTemporaryFiles();
  let job: Loaded | null = null;
  try {
    job = await load(jobId, lang, true);
    await renderPlan({
      source: job.source, plan: job.plan, voice: job.voice!, encoder: choice.encoder, target: save.target,
      fastStart: false, signal, beforeFinalize: save.allowCommit,
      onProgress: (p) => onProgress({ stage: "rendering", fraction: p.done / p.total }),
    });
    await save.finish();
  } catch (e) {
    await save.discard();
    throw e;
  } finally {
    job?.source.dispose();
  }
}

export const downloadName = (jobName: string, lang: string) => `${jobName.replace(/[^\w.\- ]/g, "_")}_${lang}.mp4`;
