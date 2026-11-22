// What vt.cmd_analyze learns from ffprobe, read with Mediabunny from the file itself (the browser's File, or a link
// to it in storage; in Node a file path for the tests): the tracks, codecs, the shown size (rotation applied, as
// vt.video_size), the frame rate and length as ffprobe reports them (timing.ts), the colours, and every frame's
// timestamp. Reads only the file's index (no decoding).

import { EncodedPacketSink, type Input, type InputVideoTrack } from "mediabunny";
import { fileStart } from "../render/render";
import { probeDuration, rFrameRate, variableFrameRate } from "./timing";

export type VideoFacts = {
  container: string;
  video: {
    codec: string | null;
    /** e.g. avc1.640028 */
    codecString: string | null;
    codedWidth: number;
    codedHeight: number;
    /** the size it's shown at, rotation applied (vt.video_size) */
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
    colorSpace: VideoColorSpaceInit;
    hdr: boolean;
    /** the frames' presentation times in ticks of `timescale`, sorted */
    ticks: number[];
    timescale: number;
    /** ffprobe's r_frame_rate */
    fps: number;
    fpsRational: [number, number];
    variable: boolean;
  } | null;
  audio: { codec: string | null; codecString: string | null; channels: number; sampleRate: number } | null;
  /** ffprobe's format duration (seconds, whole microseconds) */
  duration: number;
  /** where the file starts (ffmpeg counts times from here) */
  start: number;
};

/** Every frame's presentation time in ticks, from the file's index. */
async function frameTicks(track: InputVideoTrack, timescale: number): Promise<number[]> {
  const out: number[] = [];
  const sink = new EncodedPacketSink(track);
  for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) out.push(Math.round(p.timestamp * timescale));
  return out.sort((a, b) => a - b);
}

export async function readFacts(input: Input): Promise<VideoFacts> {
  const format = await input.getFormat();
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  const duration = probeDuration(await input.computeDuration());
  let video: VideoFacts["video"] = null;
  if (v) {
    const timescale = await v.getTimeResolution();
    const ticks = await frameTicks(v, timescale);
    const fpsRational = rFrameRate(ticks, timescale);
    const rotation = (((v.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    const codedWidth = v.codedWidth, codedHeight = v.codedHeight;
    video = {
      codec: v.codec, codecString: await v.getCodecParameterString(), codedWidth, codedHeight,
      width: rotation % 180 ? codedHeight : codedWidth, height: rotation % 180 ? codedWidth : codedHeight, rotation,
      colorSpace: await v.getColorSpace(), hdr: await v.hasHighDynamicRange(), ticks, timescale,
      fps: fpsRational[0] / fpsRational[1], fpsRational, variable: variableFrameRate(ticks),
    };
  }
  const audio = a ? { codec: a.codec, codecString: await a.getCodecParameterString(), channels: a.numberOfChannels, sampleRate: a.sampleRate } : null;
  return { container: format.name, video, audio, duration, start: await fileStart(input) };
}
