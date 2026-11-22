// The plan inputs of one language: what the browser builds plan.json and voice.wav from. Written today by the
// worker after the voice is recorded (vt.plan_inputs); from phase 3 on by the app's own TTS route, in exactly
// this format. Stored in R2 under u/<user>/<job>/out/<lang>/g<generation>/ (see "Files in storage" in
// docs/web-setup.md):
//
//   inputs.json      -> PlanInputs below ("format": 1)
//   tts/<name>.mp3   -> one ElevenLabs clip per beat (mp3_44100_128), as the API returned it
//   tts/<name>.json  -> ClipMeta below: the text that was voiced and the API's per-character timing
//
// Raise INPUTS_FORMAT (here and in vt.py) when a change means older inputs can't be read.

import { FIT_KEYS, type Fit } from "./config";

export const INPUTS_FORMAT = 1;

/** One cut of the original video, tied to the word spoken at that moment (vt.cmd_analyze). */
export type Anchor =
  | { id: number; t: number; kind: "lead"; frac: number }
  | { id: number; t: number; kind: "tail"; off: number }
  | { id: number; t: number; kind: "in" | "gap"; token: number; frac: number };

export type Analysis = {
  /** the original video: length in seconds and frame rate (ffprobe r_frame_rate as a float) */
  video: { dur: number; fps: number };
  /** the size ffmpeg shows the video at, rotation applied (vt.video_size): plan.json "source" */
  source: { width: number; height: number };
  /** when the original voiceover's first word starts and its last word ends (seconds) */
  speech_start: number;
  speech_end: number;
  /** integrated loudness of the original video (LUFS, as vt.lufs reads it: one decimal) */
  base_lufs: number;
  /** the original's beats: spoken length and the pause after each */
  beats: { id: number; dur: number; pause_after: number }[];
  /** every word of the original script, with the beat (index) it is in */
  tokens: { beat: number }[];
  anchors: Anchor[];
};

export type PlanInputs = {
  format: number;
  lang: string;
  /** the ElevenLabs voice the clips were made with: pinned for this job and language */
  voice_id: string;
  analysis: Analysis;
  fit: Fit;
  /** the translation, one entry per beat, with {n} cut markers in the text */
  script: { id: number; text: string; speed?: number | null }[];
  /** one clip per beat, in beat order: file is the name in tts/; speed the TTS speed it was voiced at */
  clips: { beat: number; file: string; speed: number }[];
};

/** tts/<name>.json: what vt.tts_beat keeps next to each clip. Times are seconds into the clip. */
export type ClipMeta = {
  text: string;
  speed: number;
  alignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
  normalized_alignment?: unknown;
};

/** A clip file name in tts/: a plain name, so it can never point outside the language's folder. */
export const CLIP_FILE = /^[A-Za-z0-9_-]{1,64}\.mp3$/;
export const metaFile = (mp3: string) => mp3.replace(/\.mp3$/, ".json");

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);

/** Check a downloaded inputs.json and return it typed; throws a readable error when a plan can't be built from it. */
export function parseInputs(json: unknown): PlanInputs {
  const p = json as Partial<PlanInputs> | null;
  const bad = (what: string) => new Error(`the recorded voice can't be used (${what}): translate this language again`);
  if (!p || typeof p !== "object") throw bad("unreadable");
  if (p.format !== INPUTS_FORMAT) throw bad(`format ${p.format ?? "none"}, expected ${INPUTS_FORMAT}`);
  const a = p.analysis;
  if (!a || !num(a.video?.dur) || !(a.video.fps > 0) || !num(a.speech_start) || !num(a.speech_end) || !num(a.base_lufs))
    throw bad("no analysis");
  if (!(Number.isInteger(a.source?.width) && a.source.width > 0 && Number.isInteger(a.source?.height) && a.source.height > 0))
    throw bad("no video size");
  if (!Array.isArray(a.beats) || !a.beats.length || !Array.isArray(a.tokens) || !a.tokens.length || !Array.isArray(a.anchors))
    throw bad("no beats");
  for (const an of a.anchors) {
    if (!num(an?.t) || !["lead", "tail", "in", "gap"].includes(an.kind)) throw bad("a cut is invalid");
    if ((an.kind === "in" || an.kind === "gap") && !(Number.isInteger(an.token) && an.token >= 0 && an.token < a.tokens.length))
      throw bad("a cut points at a word that isn't there");
  }
  if (!p.fit || FIT_KEYS.some((k) => !num(p.fit![k]))) throw bad("no fitting limits");
  if (!Array.isArray(p.script) || p.script.length !== a.beats.length) throw bad("the translation has a different number of beats");
  if (!Array.isArray(p.clips) || p.clips.length !== p.script.length) throw bad("a beat has no recorded voice");
  for (const c of p.clips) if (typeof c?.file !== "string" || !CLIP_FILE.test(c.file) || !num(c.speed)) throw bad("a clip is invalid");
  if (typeof p.lang !== "string" || typeof p.voice_id !== "string") throw bad("no language or voice");
  return p as PlanInputs;
}

/** Check one clip's tts/<name>.json. */
export function parseClipMeta(json: unknown, file: string): ClipMeta {
  const m = json as Partial<ClipMeta> | null;
  if (!m || typeof m !== "object" || typeof m.text !== "string")
    throw new Error(`the timing of ${file} is unreadable: translate this language again`);
  return { ...m, alignment: m.alignment ?? null } as ClipMeta;
}
