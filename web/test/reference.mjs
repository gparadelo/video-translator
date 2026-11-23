// ffmpeg-only references for the tests: what the browser's results are checked against, made by ffmpeg and ffprobe
// themselves (no Python). These are the commands the old Python pipeline ran, so the browser still has to match
// ffmpeg bit for bit where it did before. Plain JavaScript, shared by the vitest tests and test/e2e/run.mjs.
//
//   media(video)                         length and frame rate (ffprobe), shown size, cuts (select=scene), loudness
//   sceneScores(video)                   ffmpeg's scene score of every frame, with its pts_time
//   lufs(file)                           integrated loudness as ffmpeg's ebur128 prints it (one decimal)
//   voiceover(video, out)                the mono AAC voiceover ffmpeg extracts
//   frameVideo(out, {...})               a video with its frame number drawn into every frame
//   frameCodes(video)                    the frame number shown in each frame of a video
//   segmentCmd(...), segmentCodes(...)   one plan clip rendered with ffmpeg, and the frames it shows
//   toneClip(...)                        a fake TTS clip: tone bursts, MP3 (libmp3lame)
//   voiceTrack(plan, clipDir, lufs, out) a plan's voice.wav made with ffmpeg (atrim, atempo, volume, alimiter)
//   renderReference(plan, src, voice, out)   a plan rendered with ffmpeg, clip by clip, then joined
//   compareRender(video, reference)      frames, size and voice of a render against a reference render

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe } from "./videos.mjs";

const SR = 44100;
const run = (args) => execFileSync(args[0], args.slice(1), { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
/** A command's stderr (where ffmpeg's filters print), whatever it exits with. */
function stderrOf(args) {
  const r = spawnSync(args[0], args.slice(1), { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  return r.stderr;
}

/** Python's round(): halves to the even integer. */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's f"{x:.{digits}f}": the exact value of the double, rounded half to even (toFixed rounds ties up). */
export function fixed(x, digits) {
  const neg = x < 0 || Object.is(x, -0);
  const [int, frac] = Math.abs(x).toFixed(100).split(".");
  const rest = frac.slice(digits);
  let s = int + frac.slice(0, digits);
  const up = rest[0] > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || Number(s.at(-1)) % 2 === 1));
  if (up) s = (BigInt(s) + BigInt(1)).toString().padStart(s.length, "0");
  const out = digits ? `${s.slice(0, s.length - digits) || "0"}.${s.slice(-digits)}` : s;
  return neg && /[1-9]/.test(out) ? `-${out}` : out;
}

/** Python's str(float): the shortest repr, with ".0" on whole numbers (ffmpeg's fps= parses both the same). */
const pyStr = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));

const videoStream = (p) => p.streams.find((s) => s.codec_type === "video");

/** The size a video is shown at (width, height), phone rotation applied, as ffmpeg decodes it. */
export function shownSize(path) {
  const vs = videoStream(probe(path));
  let [w, h] = [Number(vs.width), Number(vs.height)];
  let rot = vs.tags?.rotate;
  for (const sd of vs.side_data_list ?? []) if ("rotation" in sd) rot = sd.rotation;
  if (rot !== undefined && Math.abs(Math.trunc(Number(rot))) % 180 === 90) [w, h] = [h, w];
  return [w, h];
}

/** Integrated loudness as ffmpeg's ebur128 summary prints it (LUFS, one decimal); -16 when there is none. */
export function lufs(path) {
  const stderr = stderrOf(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  const m = [...stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  return m.length ? Number(m.at(-1)[1]) : -16.0;
}

/** The scene cuts ffmpeg finds: frames scoring above `threshold` at 270 px wide, snapped to the frame grid. */
export function detectCuts(video, threshold, dur, fps) {
  const stderr = stderrOf(["ffmpeg", "-hide_banner", "-i", video, "-an", "-vf",
    `scale=270:-2,select='gt(scene,${threshold})',metadata=print`, "-f", "null", "-"]);
  const ts = [...new Set([...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => roundHalfEven(Number(m[1]) * fps) / fps))].sort((a, b) => a - b);
  return ts.filter((t) => 0.05 < t && t < dur - 0.05);
}

/** What is measured of a video before it is transcribed: length and frame rate (ffprobe), shown size, cuts, loudness. */
export function media(video, threshold = 0.2) {
  const p = probe(video);
  const vs = videoStream(p);
  const [num, den] = vs.r_frame_rate.split("/").map(Number);
  const fps = num / den;
  const dur = Number(p.format.duration);
  const [width, height] = shownSize(video);
  return { dur, fps, r_frame_rate: vs.r_frame_rate, width, height, cuts: detectCuts(video, threshold, dur, fps), base_lufs: lufs(video) };
}

/** ffmpeg's scene score of every frame (scale=270:-2, select, metadata=print): [pts_time, score] as printed. */
export function sceneScores(video) {
  const stderr = stderrOf(["ffmpeg", "-hide_banner", "-i", video, "-an", "-vf",
    "scale=270:-2,select='gte(scene,0)',metadata=print", "-f", "null", "-"]);
  return [...stderr.matchAll(/pts_time:([0-9.e+-]+)\s*\n[\s\S]*?lavfi\.scene_score=([0-9.]+)/g)].map((m) => [m[1], m[2]]);
}

/** The voiceover as ffmpeg extracts it: mono AAC at 128k. */
export function voiceover(video, out) {
  run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "128k", out]);
  return out;
}

// ---- frame numbers drawn into videos, so renders can be checked frame by frame

const BITS = 16;

/**
 * A synthetic video: testsrc2 with the frame number written as 16 black/white blocks across the top ninth (block i
 * is white when bit i of the frame number is set), plus a sine tone.
 */
/** @param {string} out @param {{ rate?: string, seconds?: number, timescale?: number | null, size?: number[] }} [o] */
export function frameVideo(out, { rate = "30", seconds = 12, timescale = null, size = [640, 360] } = {}) {
  const [w, h] = size;
  const band = Math.round(h / 9);
  const code = `if(mod(floor(N/pow(2\\,floor(X*${BITS}/${w})))\\,2)\\,255\\,0)`;
  run(["ffmpeg", "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=${w}x${h}:r=${rate}:d=${seconds}`,
    "-f", "lavfi", "-i", `color=black:s=${w}x${band}:r=${rate}:d=${seconds},format=gray,geq=lum='${code}'`,
    "-f", "lavfi", "-i", `sine=f=440:d=${seconds}`,
    "-filter_complex", "[1]format=yuv420p[b];[0][b]overlay=0:0",
    "-c:v", "libx264", "-g", "30", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ...(timescale ? ["-video_track_timescale", String(timescale)] : []), out]);
  return out;
}

/** The frame number written in each frame of `video` (any size: the band is scaled back to 16 blocks). */
export function frameCodes(video) {
  const d = run(["ffmpeg", "-v", "error", "-i", video, "-vf", `crop=iw:ih/9:0:0,scale=${BITS}:1:flags=area,format=gray`, "-f", "rawvideo", "-"]);
  const out = [];
  for (let k = 0; k < Math.floor(d.length / BITS); k++) {
    let c = 0;
    for (let i = 0; i < BITS; i++) if (d[k * BITS + i] > 127) c += 2 ** i;
    out.push(c);
  }
  return out;
}

/** The frame rate of a video as a float (ffprobe's r_frame_rate). */
export function fpsOf(video) {
  const [num, den] = videoStream(probe(video)).r_frame_rate.split("/").map(Number);
  return num / den;
}

/**
 * How one clip of a plan is retimed: its frames slowed down or sped up, resampled to the output frame rate, scaled,
 * and the last frame held for as long as the clip needs (-frames:v ends it). lib/render/frames.ts picks the same frames.
 */
export const segmentFilter = (s, fps, W, H) => `setpts=(PTS-STARTPTS)/${fixed(s.speed, 5)},fps=${pyStr(fps)},scale=${W}:${H},tpad=stop_mode=clone:stop=-1`;

/** The ffmpeg command that renders one clip of the plan: exactly s.frames frames. */
export const segmentCmd = (src, s, fps, W, H, venc, out) => ["ffmpeg", "-y", "-v", "error", "-ss", fixed(s.src_start, 4),
  "-t", fixed(s.src_len + 0.1, 4), "-i", src, "-an", "-vf", segmentFilter(s, fps, W, H), "-frames:v", String(s.frames), ...venc, out];

/** Each clip rendered with ffmpeg (lossless, so the blocks survive), and the source frame shown in every output frame. */
export function segmentCodes(src, clips, size = [640, 360]) {
  const fps = fpsOf(src);
  const tmp = mkdtempSync(join(tmpdir(), "vt-seg-"));
  try {
    return clips.map((s, i) => {
      const f = join(tmp, `seg${i}.mp4`);
      run(segmentCmd(src, s, fps, size[0], size[1], ["-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p"], f));
      return frameCodes(f);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- the voice track and the render of a plan, as ffmpeg makes them

/** A fake TTS clip: an MP3 (libmp3lame: a LAME header with the encoder delay) with a tone during each [start, end]. */
export function toneClip(path, spans, dur, freq, levelDb) {
  const env = spans.map(([a, b]) => `between(t,${fixed(a, 4)},${fixed(b, 4)})`).join("+") || "0";
  const amp = 10 ** (levelDb / 20);
  run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${fixed(amp, 6)}*(${env})*sin(2*PI*${freq}*t)':s=${SR}:d=${fixed(dur, 4)}`,
    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", path]);
  return path;
}

/**
 * One beat's clip as it goes into the voice track: samples [round(clip_in * SR), round(clip_out * SR)) of the decoded
 * file (the whole file decoded and trimmed, not seeked into), then its tempo (a tempo of exactly 1 is left alone).
 */
export function clipFilter(b) {
  const f = `atrim=start_sample=${roundHalfEven(b.clip_in * SR)}:end_sample=${roundHalfEven(b.clip_out * SR)}`;
  return b.tempo === 1 ? f : `${f},asetpts=PTS-STARTPTS,atempo=${fixed(b.tempo, 4)}`;
}

/**
 * A plan's voice.wav made with ffmpeg: every beat's clip (clipDir/<beat.audio>) at its tempo and offset, loudness
 * matched to `baseLufs` and limited (volume, alimiter=limit=0.95:level=0), made stereo as `-ac 2` does, exactly
 * total_frames / fps long, 16-bit PCM at 44.1 kHz.
 */
export function voiceTrack(plan, clipDir, baseLufs, out) {
  const total = plan.total_frames / plan.fps;
  const pcm = new Int16Array(roundHalfEven(total * SR));
  for (const b of plan.beats) {
    const raw = run(["ffmpeg", "-v", "error", "-i", join(clipDir, b.audio), "-af", clipFilter(b), "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"]);
    const clip = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length & ~1)));
    const start = roundHalfEven(b.offset * SR);
    const n = Math.min(clip.length, pcm.length - start);
    if (n > 0) pcm.set(clip.subarray(0, n), start);
  }
  const tmp = mkdtempSync(join(tmpdir(), "vt-voice-"));
  try {
    const rawPath = join(tmp, "voice_raw.pcm"), plain = join(tmp, "voice_plain.wav");
    writeFileSync(rawPath, Buffer.from(pcm.buffer));
    run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", String(SR), "-ac", "1", "-i", rawPath, plain]);
    const gain = baseLufs - lufs(plain);
    run(["ffmpeg", "-y", "-v", "error", "-i", plain, "-af", `volume=${fixed(gain, 2)}dB,alimiter=limit=0.95:level=0`, "-ac", "2",
      "-ar", String(SR), "-c:a", "pcm_s16le", "-t", fixed(total, 4), out]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/** A plan rendered with ffmpeg: every clip with segmentCmd at the plan's source size (even), joined, the voice muxed in. */
export function renderReference(plan, source, voice, out) {
  const fps = plan.fps;
  const W = Math.max(2, plan.source.width - (plan.source.width % 2)), H = Math.max(2, plan.source.height - (plan.source.height % 2));
  const tmp = mkdtempSync(join(tmpdir(), "vt-render-"));
  try {
    const venc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"];
    const list = plan.segments.map((s) => {
      const f = join(tmp, `${String(s.seg).padStart(3, "0")}.mp4`);
      run(segmentCmd(source, s, fps, W, H, venc, f));
      return `file '${f}'`;
    });
    writeFileSync(join(tmp, "list.txt"), list.join("\n") + "\n");
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(tmp, "list.txt"), "-i", voice, "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", fixed(plan.total_frames / fps, 4), out]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/** Mono float samples of a file's sound, as ffmpeg decodes it. */
function pcmOf(video) {
  const d = run(["ffmpeg", "-v", "error", "-i", video, "-map", "0:a", "-ac", "1", "-f", "f32le", "-"]);
  return new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
}

/**
 * A render against a reference render of the same plan: the frame number shown in every frame, size, and how well
 * the voice lines up (the best offset within 300 samples, and the relative error).
 */
export function compareRender(video, ref) {
  const p = probe(video);
  const vs = videoStream(p);
  const got = frameCodes(video), want = frameCodes(ref);
  const a = pcmOf(video), b = pcmOf(ref);
  const n = Math.min(a.length, b.length);
  let best = 0, bestSum = Infinity;
  for (let off = -300; off <= 300; off++) {
    let sum = 0;
    for (let i = 4096; i < n - 4096; i += 97) sum += Math.abs(a[i] - b[i + off]);
    if (sum < bestSum) [best, bestSum] = [off, sum];
  }
  let err = 0, ref2 = 0;
  for (let i = 0; i < n; i++) {
    err += (a[i] - b[i]) ** 2;
    ref2 += b[i] * b[i];
  }
  const same = got.length === want.length && got.every((x, i) => x === want[i]);
  let firstMismatch = got.findIndex((x, i) => i < want.length && x !== want[i]);
  if (firstMismatch < 0) firstMismatch = got.length === want.length ? null : Math.min(got.length, want.length);
  return { width: vs.width, height: vs.height, codec: vs.codec_name, frames: got.length, ref_frames: want.length, same,
           first_mismatch: firstMismatch, audio_samples: a.length, ref_audio_samples: b.length, audio_offset: best,
           audio_rel_error: err / Math.max(1, ref2), duration: Number(p.format.duration) };
}
