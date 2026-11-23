// What the job page does with a new video (job "preparing") or an approved, edited transcript ("aligning"): it
// measures the video here in the browser (local.ts) and calls the prepare steps (lib/prepare/steps.ts, through
// app/api/jobs/<id>/prepare/...) one after another, as the old Python pipeline's prepare() did on the worker:
//
//   media (measure the video, upload the voiceover and prep/media.json) -> transcribe -> names -> align
//   aligning: media (only if it isn't there yet) -> align
//
// Each step saves what it made, so this can stop at any point (tab closed, network gone) and start again: it then
// continues from what's saved and pays nothing twice. Passing problems are tried again with growing pauses
// (callStep); anything else ends with the step's message. Browser code (the measuring needs WebCodecs); the tests
// give it a fake fetch, upload and measure.

import { uploadVideo } from "../jobs";
import { ProduceError } from "../produce/errors";
import { callStep, type StepOptions } from "../produce/run";
import type { Measured, MeasureProgress } from "./local";
import { AUDIO_FILES, type AudioFile } from "./media";
import type { AlignResult, MediaResult, NamesStepResult, TranscribeResult } from "./steps";

export type PrepareProgress =
  | { stage: "starting" }
  | { stage: "measuring"; part: MeasureProgress["stage"]; fraction: number }
  | { stage: "uploading"; fraction: number }
  | { stage: "transcribing" }
  | { stage: "names" }
  | { stage: "timing" };

export type PrepareOptions = StepOptions & {
  jobId: string;
  /** this browser's id, as it holds the job (hold_prepare): the routes answer only the holder */
  runner: string;
  status: "preparing" | "aligning";
  /** the video itself, when this tab still has it (just uploaded): then nothing is downloaded */
  file?: Blob | null;
  onProgress?: (p: PrepareProgress) => void;
  /** for tests */
  measure?: (source: Blob | string, measure: boolean, onProgress: (p: MeasureProgress) => void, signal?: AbortSignal) => Promise<Measured>;
  put?: (url: string, body: Uint8Array, contentType: string, onProgress: (f: number) => void, signal?: AbortSignal) => Promise<void>;
};

const xhrPut: NonNullable<PrepareOptions["put"]> = (url, body, contentType, onProgress, signal) =>
  uploadVideo(new Blob([body as Uint8Array<ArrayBuffer>], { type: contentType }), { url, headers: { "Content-Type": contentType } }, onProgress, signal);

/** media.json and the voiceover in storage: measured here (or taken from an older worker's analysis) and uploaded. */
async function media(o: PrepareOptions, url: string) {
  const started = await callStep<MediaResult>(o, url, { runner: o.runner, phase: "start" });
  if (started.ready) return;
  if (!("measure" in started)) throw new ProduceError("unexpected answer from the server", { retry: true });
  const measure = o.measure ?? (await import("./local")).measureVideo;
  const m = await measure(o.file ?? started.source, started.measure, (p) => o.onProgress?.({ stage: "measuring", part: p.stage, fraction: p.fraction }), o.signal);
  const audio: { file: AudioFile; bytes: Uint8Array } = m.audio;
  const json = started.measure ? new TextEncoder().encode(JSON.stringify({ ...m.media, audio_bytes: audio.bytes.length })) : null;
  const up = await callStep<MediaResult>(o, url, { runner: o.runner, phase: "upload", audio: audio.file, audio_bytes: audio.bytes.length,
                                                   ...(json && { media_bytes: json.length }) });
  if (!("uploads" in up)) throw new ProduceError("unexpected answer from the server", { retry: true });
  const put = o.put ?? xhrPut;
  const total = audio.bytes.length + (json?.length ?? 0);
  o.onProgress?.({ stage: "uploading", fraction: 0 });
  for (let attempt = 1; ; attempt++) {
    try {
      await put(up.uploads.audio, audio.bytes, AUDIO_FILES[audio.file], (f) => o.onProgress?.({ stage: "uploading", fraction: (f * audio.bytes.length) / total }), o.signal);
      if (json && up.uploads.media) await put(up.uploads.media, json, "application/json", () => {}, o.signal);
      break;
    } catch (e) {
      if (o.signal?.aborted || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  await callStep<MediaResult>(o, url, { runner: o.runner, phase: "done", audio: audio.file, audio_bytes: audio.bytes.length });
}

/** Prepare (or align) the job. Resolves with where the job is now. */
export async function prepareJob(o: PrepareOptions): Promise<AlignResult["status"]> {
  const base = `/api/jobs/${o.jobId}/prepare`;
  for (let restart = 0; ; restart++) {
    try {
      o.onProgress?.({ stage: "starting" });
      await media(o, `${base}/media`);
      if (o.status === "preparing") {
        o.onProgress?.({ stage: "transcribing" });
        await callStep<TranscribeResult>(o, `${base}/transcribe`, { runner: o.runner });
        o.onProgress?.({ stage: "names" });
        await callStep<NamesStepResult>(o, `${base}/names`, { runner: o.runner });
      }
      o.onProgress?.({ stage: "timing" });
      return (await callStep<AlignResult>(o, `${base}/align`, { runner: o.runner })).status;
    } catch (e) {
      // something saved went missing or didn't check out: start again from what is there now
      if (e instanceof ProduceError && e.code === "stale" && restart < 3) continue;
      throw e;
    }
  }
}
