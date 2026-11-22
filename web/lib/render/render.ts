// Renders one language in the browser: reads the source from storage in pieces (HTTP range requests),
// decodes it with WebCodecs, picks the frames for every clip of the plan (frames.ts), scales them, encodes
// them and muxes them with the voice track into an MP4 (Mediabunny). One decoded frame is held at a time
// and the encoder's backpressure is respected, so memory stays flat even for 4K.

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  NullTarget,
  Output,
  Quality as MbQuality,
  UrlSource,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type InputVideoTrack,
  type Target,
  type VideoCodec,
} from "mediabunny";
import { frameTime, SegmentSelector, segmentTiming, sourceWindow } from "./frames";
import { ffmpegRate } from "./numbers";
import type { RenderPlan } from "./plan";
import { AUDIO_BITRATE, AVC_FACTOR, type Quality } from "./quality";
import type { Pcm } from "./wav";

export type Encoder = {
  codec: VideoCodec;
  bitrate: number;
  hardwareAcceleration: "prefer-hardware" | "no-preference";
  width: number;
  height: number;
};

/**
 * Always "quality", for every size and the preview: in "realtime" mode an encoder may drop frames to keep up
 * (Mediabunny's docs say so), and every frame has to be there for the cuts to stay on their words.
 */
const LATENCY_MODE = "quality";

/**
 * The best encoder this browser has for a size: HEVC (smaller files) before H.264 unless `codecs` says
 * otherwise, hardware before software. null when none works.
 */
export async function findEncoder(q: Quality, codecs: VideoCodec[] = ["hevc", "avc"]): Promise<Encoder | null> {
  for (const codec of codecs) {
    const bitrate = codec === "avc" ? Math.round(q.bitrate * AVC_FACTOR) : q.bitrate;
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
      const ok = await canEncodeVideo(codec, {
        width: q.width,
        height: q.height,
        quality: new MbQuality({ bitrate }),
        hardwareAcceleration,
        latencyMode: LATENCY_MODE,
      }).catch(() => false);
      if (ok) return { codec, bitrate, hardwareAcceleration, width: q.width, height: q.height };
    }
  }
  return null;
}

export const canEncodeVoice = () =>
  canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 44100, quality: new MbQuality({ bitrate: AUDIO_BITRATE }) }).catch(() => false);

/** Can this browser do the work at all? null if yes, otherwise what's missing (for the person). */
export function missingApis(): string | null {
  if (typeof window === "undefined") return "not in a browser";
  const w = window as unknown as Record<string, unknown>;
  for (const api of ["VideoDecoder", "VideoEncoder", "AudioEncoder", "VideoFrame", "OffscreenCanvas"]) {
    if (!(api in w)) return api;
  }
  return null;
}

export type Source = {
  input: Input;
  track: InputVideoTrack;
  /** Displayed size, rotation applied (what ffmpeg decodes to). */
  width: number;
  height: number;
  timescale: number;
  fileStart: number;
  dispose(): void;
};

/**
 * Where the file starts, as ffmpeg counts it (its -ss seeks relative to this): the earliest track start.
 * Mediabunny reports AAC encoder priming as a slightly negative audio start that ffmpeg doesn't count, so
 * negative starts count as 0.
 */
export async function fileStart(input: Input): Promise<number> {
  const starts = await Promise.all((await input.getTracks()).map((t) => t.getFirstTimestamp()));
  return starts.length ? Math.min(...starts.map((s) => Math.max(0, s))) : 0;
}

/** Open the source video from a (signed) URL. Only the parts that are needed get downloaded. */
export async function openSource(url: string): Promise<Source> {
  const input = new Input({ source: new UrlSource(url, { maxCacheSize: 64 * 2 ** 20 }), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("the video has no picture track");
    if (!(await track.canDecode())) throw new Error(`this browser can't decode this video (${track.codec ?? "unknown codec"})`);
    return {
      input,
      track,
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
      timescale: await track.getTimeResolution(),
      fileStart: await fileStart(input),
      dispose: () => input.dispose(),
    };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

export type RenderProgress = { done: number; total: number };

export type RenderJob = {
  source: Source;
  plan: RenderPlan;
  voice: Pcm;
  encoder: Encoder;
  target: Target;
  /** "in-memory" for files that are uploaded and played while loading; false (moov at the end) streams to disk. */
  fastStart: false | "in-memory";
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  /** Called right before the file is finalized (everything was added). */
  beforeFinalize?: () => void;
};

const AUDIO_CHUNK = 44100; // frames per AudioSample (one second at 44.1 kHz)

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("stopped", "AbortError");
}

/** Draws decoded frames scaled (and rotated) onto one canvas and turns it into frames for the encoder. */
class Painter {
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("this browser can't draw video frames");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    this.ctx = ctx;
  }
  /** A snapshot of `sample` at the output size; close it when done. */
  paint(sample: VideoSample): VideoFrame {
    sample.drawWithFit(this.ctx, { fit: "fill" });
    return new VideoFrame(this.canvas, { timestamp: 0 });
  }
}

/** Render the whole plan into `target`. Resolves with the number of video frames the encoder produced. */
export async function renderPlan(job: RenderJob): Promise<{ frames: number; encoded: number }> {
  const { source, plan, voice, encoder, signal } = job;
  const rate = ffmpegRate(plan.fps);
  const frameDur = frameTime(1, rate);
  const total = plan.total_frames;
  const duration = frameTime(total, rate);

  let encoded = 0;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: job.fastStart }), target: job.target });
  const video = new VideoSampleSource({
    codec: encoder.codec,
    quality: new MbQuality({ bitrate: encoder.bitrate }),
    hardwareAcceleration: encoder.hardwareAcceleration,
    latencyMode: LATENCY_MODE,
    keyFrameInterval: 2,
    onEncodedPacket: () => void encoded++,
  });
  const audio = new AudioSampleSource({ codec: "aac", quality: new MbQuality({ bitrate: AUDIO_BITRATE }) });
  output.addVideoTrack(video, { frameRate: rate.num / rate.den });
  output.addAudioTrack(audio);

  const sink = new VideoSampleSink(source.track);
  const painter = new Painter(encoder.width, encoder.height);
  const audioFrames = Math.min(voice.frames, Math.round(duration * voice.sampleRate));
  let audioAt = 0; // frames of voice added so far

  /** Keep the voice about a second ahead of the picture, so the muxer never has to buffer much of either. */
  async function feedAudio(untilSeconds: number) {
    const until = Math.min(audioFrames, Math.ceil(untilSeconds * voice.sampleRate));
    while (audioAt < until) {
      const n = Math.min(AUDIO_CHUNK, audioFrames - audioAt);
      const sample = new AudioSample({
        data: voice.data.subarray(audioAt * voice.channels, (audioAt + n) * voice.channels),
        format: "s16",
        numberOfChannels: voice.channels,
        sampleRate: voice.sampleRate,
        timestamp: audioAt / voice.sampleRate,
      });
      await audio.add(sample);
      sample.close();
      audioAt += n;
    }
  }

  let index = 0; // output frames added so far
  async function emit(frame: VideoFrame, times: number) {
    for (let k = 0; k < times; k++) {
      const t = frameTime(index, rate);
      const sample = new VideoSample(new VideoFrame(frame, { timestamp: Math.round(t * 1e6), duration: Math.round(frameDur * 1e6) }), {
        timestamp: t,
        duration: frameDur,
      });
      try {
        await video.add(sample);
      } finally {
        sample.close();
      }
      index++;
      if (index % 8 === 0 || index === total) job.onProgress?.({ done: index, total });
      if (index % 30 === 0) await feedAudio(frameTime(index, rate) + 1);
    }
  }

  let ok = false;
  try {
    await output.start();
    await feedAudio(1);
    for (const seg of plan.segments) {
      checkAborted(signal);
      const timing = segmentTiming(seg, plan.fps, source.timescale, source.fileStart);
      const sel = new SegmentSelector(timing);
      const win = sourceWindow(timing);
      let held: VideoSample | null = null;
      try {
        // A little before the seek point (rounding), and well after the window: the window is counted from the
        // seek point, but a clip ends `durTicks` after its first kept frame, which can be a long frame gap later
        // (low or variable frame rates). The selector decides exactly; decoding stops at the first frame past it.
        for await (const sample of sink.samples(Math.max(0, win.start - 0.002), win.end + 1)) {
          if (signal?.aborted) {
            sample.close();
            checkAborted(signal);
          }
          const step = sel.offer(Math.round(sample.timestamp * source.timescale));
          if (step.kind === "before") {
            sample.close();
            continue;
          }
          if (step.kind === "after") {
            sample.close();
            break;
          }
          if (held && step.emitHeld > 0) {
            const frame = painter.paint(held);
            try {
              await emit(frame, step.emitHeld);
            } finally {
              frame.close();
            }
          }
          held?.close();
          held = sample;
          if (sel.full) break; // the clip is complete; later frames can't be shown
        }
        if (!held) throw new Error(`clip ${seg.seg + 1}: no frames in the source at ${seg.src_start.toFixed(2)}s`);
        const rest = sel.finish();
        if (rest > 0) {
          const frame = painter.paint(held);
          try {
            await emit(frame, rest);
          } finally {
            frame.close();
          }
        }
      } finally {
        held?.close();
      }
    }
    if (index !== total) throw new Error(`made ${index} frames instead of ${total}`);
    await feedAudio(duration);
    checkAborted(signal);
    job.beforeFinalize?.();
    await output.finalize();
    ok = true;
    return { frames: index, encoded };
  } finally {
    if (!ok && output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
  }
}

/**
 * Time a short encode at each size (decoding and drawing the start of the source, like the real render) and
 * return the seconds per output frame for each. The clock starts when the first frame comes out of the
 * encoder, so starting the encoder and filling its look-ahead (quality mode keeps some frames back) are left
 * out, and stops when the last frame is out (after the flush). Takes about `seconds` per size.
 */
export async function measureSpeed(source: Source, encoders: Encoder[], seconds = 0.7): Promise<number[]> {
  const sink = new VideoSampleSink(source.track);
  const results: number[] = [];
  for (const enc of encoders) {
    let first = 0; // when the first packet came out
    let packets = 0;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new NullTarget() });
    const video = new VideoSampleSource({
      codec: enc.codec,
      quality: new MbQuality({ bitrate: enc.bitrate }),
      hardwareAcceleration: enc.hardwareAcceleration,
      latencyMode: LATENCY_MODE,
      onEncodedPacket: () => {
        if (!packets++) first = performance.now();
      },
    });
    output.addVideoTrack(video, { frameRate: 30 });
    try {
      await output.start();
      const painter = new Painter(enc.width, enc.height);
      let n = 0;
      for await (const sample of sink.samples()) {
        let s: VideoSample;
        try {
          s = new VideoSample(painter.paint(sample), { timestamp: n / 30, duration: 1 / 30 });
        } finally {
          sample.close();
        }
        try {
          await video.add(s);
        } finally {
          s.close();
        }
        n++;
        if (n >= 150 || (packets > 0 && performance.now() - first > seconds * 1000)) break;
      }
      await output.finalize();
      results.push(packets > 1 ? (performance.now() - first) / 1000 / (packets - 1) : NaN);
    } finally {
      if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
    }
  }
  return results;
}
