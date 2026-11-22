// What the job page does with a voiced language: download its plan inputs, decode the TTS clips, build plan.json
// and voice.wav (build.ts), upload both and mark the language ready. Browser only; load it with import().
// Every step can simply run again: nothing is recorded until both files are checked on the server.

import { api, uploadVideo } from "@/lib/jobs";
import { buildLanguage, type DecodedClip } from "./build";
import { SAMPLE_RATE } from "./config";
import { parseClipMeta, parseInputs } from "./inputs";
import { mp3Gapless, trimLikeFfmpeg } from "./mp3";

export type BuildStage = "loading" | "building" | "uploading";
export type BuildProgress = { stage: BuildStage; fraction: number };

type Links = { generation: number; inputs: string; clips: Record<string, { audio: string; timing: string }> };
type Upload = { url: string; headers: Record<string, string> };

const GONE = "the recorded voice for this language was removed (files are kept for 30 days): translate it again";

async function getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (r.status === 404) throw new Error(GONE);
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `couldn't download the ${what} (${r.status})`);
  if (data === null) throw new Error(`the ${what} is unreadable`);
  return data as T;
}

/**
 * Decode one MP3 to mono samples at 44.1 kHz with the browser's own decoder (Web Audio), cut like ffmpeg cuts it
 * (encoder delay and padding from the LAME header removed: mp3.ts). Chrome and Edge give ffmpeg's samples to the
 * last bit or so (checked by test/e2e).
 */
export async function decodeMp3(bytes: ArrayBuffer): Promise<{ samples: Float32Array; sampleRate: number }> {
  const gapless = mp3Gapless(new Uint8Array(bytes)); // read before decoding takes the buffer
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error("this browser couldn't read the recorded voice");
  }
  let samples: Float32Array;
  if (buf.numberOfChannels === 1) samples = buf.getChannelData(0);
  else {
    // ElevenLabs clips are mono; anything else is mixed down (the average of the channels)
    samples = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) samples[i] += d[i] / buf.numberOfChannels;
    }
  }
  return { samples: trimLikeFfmpeg(samples, gapless), sampleRate: buf.sampleRate };
}

/** Run `fn` over `items`, at most `n` at a time, in order of the results. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** Build and save the plan and the voice track of a voiced language. The page shows it as ready once this resolves. */
export async function prepareVoice(jobId: string, lang: string, onProgress: (p: BuildProgress) => void, signal: AbortSignal) {
  onProgress({ stage: "loading", fraction: 0 });
  const r = await fetch(`/api/jobs/${jobId}/plan/${lang}`, { signal });
  const links = (await r.json().catch(() => ({}))) as Links & { error?: string };
  if (!r.ok) throw new Error(links.error ?? `couldn't load the recorded voice (${r.status})`);
  const inputs = parseInputs(await getJson(links.inputs, "recorded voice", signal));
  let done = 0;
  const clips: DecodedClip[] = await pool(inputs.clips, 4, async (c) => {
    const l = links.clips[c.file];
    if (!l) throw new Error(GONE);
    const [meta, audio] = await Promise.all([
      getJson(l.timing, "voice timing", signal).then((j) => parseClipMeta(j, c.file)),
      fetch(l.audio, { signal }).then((a) => {
        if (a.status === 404) throw new Error(GONE);
        if (!a.ok) throw new Error(`couldn't download the recorded voice (${a.status})`);
        return a.arrayBuffer();
      }),
    ]);
    const decoded = await decodeMp3(audio);
    onProgress({ stage: "loading", fraction: ++done / inputs.clips.length });
    return { meta, ...decoded };
  });
  signal.throwIfAborted();

  onProgress({ stage: "building", fraction: 0 });
  await new Promise((res) => setTimeout(res, 0)); // let the page show it before the CPU work
  const built = buildLanguage(inputs, clips);
  const plan = new Blob([JSON.stringify(built.portable, null, 1)], { type: "application/json" });
  const voice = new Blob([built.voice], { type: "audio/wav" });
  signal.throwIfAborted();

  onProgress({ stage: "uploading", fraction: 0 });
  const sizes = { generation: links.generation, plan_bytes: plan.size, voice_bytes: voice.size };
  const up = await api<{ plan: Upload; voice: Upload }>(`/api/jobs/${jobId}/plan/${lang}`, sizes);
  await uploadVideo(plan, up.plan, () => {}, signal);
  await uploadVideo(voice, up.voice, (f) => onProgress({ stage: "uploading", fraction: f }), signal);
  await api(`/api/jobs/${jobId}/plan/${lang}`, { ...sizes, done: true });
}
