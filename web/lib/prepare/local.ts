// What the job page measures of a new video in the person's browser, instead of ffmpeg on a worker (the part of
// vt.cmd_analyze that needs the video): prep/media.json and the voiceover's sound for ElevenLabs. One pass over the
// sound and one over the picture, decoded with WebCodecs (Mediabunny); the file is the person's own (still in the
// tab after the upload), or read from storage.
//
//   - length and frame rate as ffprobe reports them, the shown size (probe.ts, timing.ts)
//   - the loudness of the original sound, as `ffmpeg -af ebur128` (lib/pipeline/loudness.ts LoudnessMeter)
//   - the voiceover for speech-to-text, as vt.py's base_vo.m4a (`-vn -ac 1 -c:a aac -b:a 128k`): mono (stereo
//     mixed down as ffmpeg does, (L + R) * 0.7071), AAC 128 kb/s in MP4; WAV when the browser has no AAC encoder
//   - the cuts (scenes.ts): every frame's luma plane, rotated and scaled like ffmpeg's `scale=270:-2` in a few Web
//     Workers (scene-worker.ts), scored in order
//
// Browser only (WebCodecs, Workers). Load it with import().

import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  type Input,
  type VideoSample,
} from "mediabunny";
import { LoudnessMeter } from "../pipeline/loudness";
import { ANALYZE } from "./config";
import { MEDIA_FORMAT, type AudioFile, type Media } from "./media";
import { checkInput } from "./checks";
import { openInput, type VideoFacts } from "./probe";
import type { SceneFrame, SceneInit, ScenePicture } from "./scene-worker";
import { cutsFromScores, SceneScorer, sceneSize } from "./scenes";

export type MeasureStage = "sound" | "cuts";
export type MeasureProgress = { stage: MeasureStage; fraction: number };

export type Measured = {
  /** null when only the voiceover was asked for */
  media: Omit<Media, "audio_bytes"> | null;
  audio: { file: AudioFile; bytes: Uint8Array };
  facts: VideoFacts;
  ms: { sound: number; cuts: number };
};

const AUDIO_BITRATE = 128_000;

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("stopped", "AbortError");
}

// ------------------------------------------------------------------ the sound

/** A 16-bit PCM WAV of mono float samples (the fallback without an AAC encoder). */
function wavOf(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  return out;
}

/** ffmpeg's -ac 1 for one frame's channels (swresample's matrix: stereo to mono is (L + R) * M_SQRT1_2, in float). */
function downmixer(channels: number): (planes: Float32Array[], i: number) => number {
  const f = Math.fround;
  const h = f(Math.SQRT1_2);
  if (channels === 1) return (p, i) => p[0][i];
  if (channels === 2) return (p, i) => f(f(p[0][i] * h) + f(p[1][i] * h));
  // more channels (rare in these videos): fronts at -3 dB, centre at 0 dB, LFE off, the rest at -6 dB
  const w = Array.from({ length: channels }, (_, c) => (c < 2 ? h : c === 2 ? 1 : c === 3 && channels >= 6 ? 0 : 0.5));
  return (p, i) => {
    let s = 0;
    for (let c = 0; c < channels; c++) s += p[c][i] * w[c];
    return f(s);
  };
}

/** One pass over the sound: its loudness, and the voiceover encoded for ElevenLabs. */
async function measureSound(input: Input, facts: VideoFacts, onProgress: (f: number) => void, signal?: AbortSignal):
  Promise<{ lufs: number; audio: { file: AudioFile; bytes: Uint8Array } }> {
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("the video has no sound track");
  const rate = track.sampleRate, channels = track.numberOfChannels;
  const meter = new LoudnessMeter(rate, channels);
  const mix = downmixer(channels);
  const end = Math.round((await track.computeDuration()) * rate); // the track's last sample, as ffmpeg trims it
  const aac = await canEncodeAudio("aac", { numberOfChannels: 1, sampleRate: rate, bitrate: AUDIO_BITRATE }).catch(() => false);

  let encoder: { source: AudioSampleSource; output: Output; target: BufferTarget } | null = null;
  if (aac) {
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const source = new AudioSampleSource({ codec: "aac", bitrate: AUDIO_BITRATE });
    output.addAudioTrack(source);
    await output.start();
    encoder = { source, output, target };
  }
  const wav: Float32Array[] = [];

  const sink = new AudioSampleSink(track);
  let at = 0; // frames written (from the start of the file)
  const total = Math.max(1, end);
  try {
    for await (const sample of sink.samples()) {
      try {
        aborted(signal);
        const n = sample.numberOfFrames;
        const planes = Array.from({ length: channels }, (_, c) => {
          const p = new Float32Array(n);
          sample.copyTo(p, { planeIndex: c, format: "f32-planar" });
          return p;
        });
        // drop what comes before the file's start (AAC priming, which ffmpeg skips) and after the track's end
        const first = Math.round((sample.timestamp - facts.start) * rate);
        const from = Math.max(0, at - first, -first);
        const to = Math.min(n, end - first);
        if (to <= from) continue;
        const cut = planes.map((p) => p.subarray(from, to));
        meter.push(cut, to - from);
        const mono = new Float32Array(to - from);
        for (let i = 0; i < mono.length; i++) mono[i] = mix(cut, i);
        if (encoder) {
          const s = new AudioSample({ data: mono, format: "f32-planar", numberOfChannels: 1, sampleRate: rate, timestamp: at / rate });
          await encoder.source.add(s);
          s.close();
        } else wav.push(mono);
        at = first + to;
        onProgress(Math.min(1, at / total));
      } finally {
        sample.close();
      }
    }
  } catch (e) {
    if (encoder) await encoder.output.cancel().catch(() => {});
    throw e;
  }
  let audio: { file: AudioFile; bytes: Uint8Array };
  if (encoder) {
    encoder.source.close();
    await encoder.output.finalize();
    audio = { file: "audio.m4a", bytes: new Uint8Array(encoder.target.buffer!) };
  } else {
    const all = new Float32Array(wav.reduce((s, p) => s + p.length, 0));
    let k = 0;
    for (const p of wav) {
      all.set(p, k);
      k += p.length;
    }
    audio = { file: "audio.wav", bytes: wavOf(all, rate) };
  }
  return { lufs: meter.lufs(), audio };
}

// ------------------------------------------------------------------ the cuts

const YUV8 = new Set(["I420", "I420A", "I422", "I422A", "I444", "I444A", "NV12"]);
const YUV10 = new Set(["I420P10", "I420AP10", "I422P10", "I422AP10", "I444P10", "I444AP10"]);

/**
 * A frame's luma plane, 8 bits: the decoder's own Y plane when it has one (the pictures ffmpeg's decoder gives, to
 * the bit). 10-bit pictures are reduced to 8 bits (ffmpeg scores them in 10 bits: within rounding); RGB frames
 * (some hardware decoders) get luma worked out from RGB (BT.709, limited range), which is close but not ffmpeg's.
 */
async function lumaOf(sample: VideoSample, w: number, h: number): Promise<{ data: ArrayBuffer; offset: number; stride: number }> {
  const fmt = sample.format ?? "";
  if (YUV8.has(fmt)) {
    const buf = new Uint8Array(sample.allocationSize());
    const layout = await sample.copyTo(buf);
    return { data: buf.buffer, offset: layout[0].offset, stride: layout[0].stride };
  }
  if (YUV10.has(fmt)) {
    const buf = new Uint8Array(sample.allocationSize());
    const layout = await sample.copyTo(buf);
    const src = new Uint16Array(buf.buffer, layout[0].offset, (layout[0].stride / 2) * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.min(255, (src[y * (layout[0].stride / 2) + x] + 2) >> 2);
    return { data: out.buffer, offset: 0, stride: w };
  }
  // RGB, or a picture only the GPU holds: draw it unrotated and work out the luma
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const frame = sample.toVideoFrame();
  try {
    ctx.drawImage(frame, 0, 0, w, h);
  } finally {
    frame.close();
  }
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round(16 + (219 * (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2])) / 255);
  }
  return { data: out.buffer, offset: 0, stride: w };
}

/** A few workers scaling frames, answering in any order; `scale` resolves with each frame's picture. */
function workerPool(init: SceneInit) {
  const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const waiting = new Map<number, { resolve: (p: Uint8Array) => void; reject: (e: Error) => void }>();
  const workers = Array.from({ length: n }, () => {
    const w = new Worker(new URL("./scene-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<ScenePicture>) => {
      const m = e.data;
      const p = waiting.get(m.id);
      waiting.delete(m.id);
      if ("error" in m) p?.reject(new Error(m.error));
      else p?.resolve(new Uint8Array(m.pic));
    };
    w.onerror = (e) => {
      for (const p of waiting.values()) p.reject(new Error(`the scene detection stopped: ${e.message}`));
      waiting.clear();
    };
    w.postMessage(init);
    return w;
  });
  let next = 0;
  return {
    size: n,
    scale(frame: Omit<SceneFrame, "type" | "id">, id: number) {
      return new Promise<Uint8Array>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        workers[next++ % n].postMessage({ type: "frame", id, ...frame } satisfies SceneFrame, [frame.data]);
      });
    },
    close: () => workers.forEach((w) => w.terminate()),
  };
}

/** One pass over the picture: every frame's scene score, then vt.detect_cuts. */
async function measureCuts(input: Input, facts: VideoFacts, onProgress: (f: number) => void, signal?: AbortSignal): Promise<number[]> {
  const v = facts.video!;
  const track = (await input.getPrimaryVideoTrack())!;
  const [dstW, dstH] = sceneSize(v.width, v.height);
  const pool = workerPool({ type: "init", codedW: v.codedWidth, codedH: v.codedHeight, rotation: v.rotation, dstW, dstH });
  const scorer = new SceneScorer();
  const frames: { t: number; score: number }[] = [];
  const total = Math.max(1, v.ticks.length);
  const pending: { t: number; pic: Promise<Uint8Array> }[] = [];
  const maxInFlight = pool.size * 2;
  const drain = async (keep: number) => {
    while (pending.length > keep) {
      const p = pending.shift()!;
      frames.push({ t: p.t, score: scorer.push(await p.pic) });
      onProgress(Math.min(1, frames.length / total));
    }
  };
  let id = 0;
  try {
    for await (const sample of new VideoSampleSink(track).samples()) {
      try {
        aborted(signal);
        if (sample.timestamp < -1e-6) continue; // before the file's start (an edit list): ffmpeg drops these
        const w = sample.visibleRect.width, h = sample.visibleRect.height;
        if (w !== v.codedWidth || h !== v.codedHeight) throw new Error(`a frame is ${w}x${h}, not ${v.codedWidth}x${v.codedHeight}`);
        const luma = await lumaOf(sample, w, h);
        pending.push({ t: sample.timestamp - facts.start, pic: pool.scale(luma, id++) });
      } finally {
        sample.close();
      }
      await drain(maxInFlight);
    }
    await drain(0);
  } finally {
    pool.close();
  }
  return cutsFromScores(frames, ANALYZE.scene_threshold, facts.duration, v.fps);
}

// ------------------------------------------------------------------ both

/**
 * Measure the video for prep/media.json (`measure`) and extract its voiceover (always). `source`: the File, or a
 * link to it in storage. Progress: the sound first (fast), then the cuts.
 */
export async function measureVideo(source: Blob | string, measure: boolean, onProgress: (p: MeasureProgress) => void,
                                   signal?: AbortSignal): Promise<Measured> {
  const input = openInput(source);
  try {
    // the same checks as when a video is picked, so a video that reached storage another way (a project from an
    // older version of the app) is refused with the same reason instead of coming out wrong
    const check = await checkInput(input);
    if (!check.ok) throw new Error(check.reason);
    const { facts } = check;
    const video = facts.video!;
    const t0 = performance.now();
    onProgress({ stage: "sound", fraction: 0 });
    const sound = await measureSound(input, facts, (fraction) => onProgress({ stage: "sound", fraction }), signal);
    const t1 = performance.now();
    let media: Measured["media"] = null;
    if (measure) {
      onProgress({ stage: "cuts", fraction: 0 });
      const cuts = await measureCuts(input, facts, (fraction) => onProgress({ stage: "cuts", fraction }), signal);
      media = {
        format: MEDIA_FORMAT, dur: facts.duration, fps: video.fps, width: video.width, height: video.height,
        base_lufs: sound.lufs, cuts, audio: sound.audio.file, from: "browser", frames: video.ticks.length,
        variable_fps: video.variable,
      };
    }
    return { media, audio: sound.audio, facts, ms: { sound: t1 - t0, cuts: performance.now() - t1 } };
  } finally {
    input.dispose();
  }
}
