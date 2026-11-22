// analysis.json: the original video and voiceover as the worker analyzed them (vt.portable_analysis), in R2 at
// u/<user>/<job>/analysis.json (jobs.analysis_key). The produce steps translate, voice and fit each language
// from it. See "Files in storage" in docs/web-setup.md. Raise ANALYSIS_FORMAT here and in vt.py when older files
// can't be read.

import type { Analysis as InputsAnalysis, Anchor } from "../pipeline/inputs";
import { ProduceError } from "./errors";

export const ANALYSIS_FORMAT = 1;

export type AnalysisBeat = {
  id: number;
  /** what the voiceover says in this beat */
  text: string;
  /** the same with a {n} marker in front of the word each cut lands on */
  marked: string;
  dur: number;
  pause_after: number;
};

export type Analysis = Omit<InputsAnalysis, "beats"> & {
  format: number;
  base_lang: string;
  beats: AnalysisBeat[];
  warnings: string[];
};

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const ANCHOR_KINDS = ["lead", "tail", "in", "gap"];

/** Check a downloaded analysis.json and return it typed. */
export function parseAnalysis(json: unknown): Analysis {
  const a = json as Partial<Analysis> | null;
  const bad = (what: string) =>
    new ProduceError(`the analysis of the video can't be used (${what}): approve the transcript again`, { status: 422 });
  if (!a || typeof a !== "object") throw bad("unreadable");
  if (a.format !== ANALYSIS_FORMAT) throw bad(`format ${a.format ?? "none"}, expected ${ANALYSIS_FORMAT}`);
  if (typeof a.base_lang !== "string" || !a.base_lang) throw bad("no language");
  if (!num(a.video?.dur) || !(num(a.video?.fps) && a.video.fps > 0)) throw bad("no video length");
  if (!(Number.isInteger(a.source?.width) && a.source!.width > 0 && Number.isInteger(a.source?.height) && a.source!.height > 0))
    throw bad("no video size");
  if (!num(a.speech_start) || !num(a.speech_end) || !num(a.base_lufs)) throw bad("no voiceover timing");
  if (!Array.isArray(a.beats) || !a.beats.length || a.beats.length > 500) throw bad("no beats");
  for (const b of a.beats) {
    if (!Number.isInteger(b?.id) || typeof b.text !== "string" || typeof b.marked !== "string" || !num(b.dur) || !num(b.pause_after))
      throw bad("a beat is invalid");
  }
  if (!Array.isArray(a.tokens) || !a.tokens.length) throw bad("no words");
  for (const t of a.tokens) if (!(Number.isInteger(t?.beat) && t.beat >= 0 && t.beat < a.beats.length)) throw bad("a word is invalid");
  if (!Array.isArray(a.anchors)) throw bad("no cuts");
  for (const an of a.anchors as Anchor[]) {
    if (!Number.isInteger(an?.id) || !num(an.t) || !ANCHOR_KINDS.includes(an.kind)) throw bad("a cut is invalid");
    if ((an.kind === "in" || an.kind === "gap") && !(Number.isInteger(an.token) && an.token >= 0 && an.token < a.tokens.length))
      throw bad("a cut points at a word that isn't there");
  }
  return { ...a, warnings: Array.isArray(a.warnings) ? a.warnings : [] } as Analysis;
}

/** The analysis as inputs.json carries it (vt.plan_inputs): what the plan is built from. */
export function inputsAnalysis(A: Analysis): InputsAnalysis {
  return {
    video: { dur: A.video.dur, fps: A.video.fps },
    source: { width: A.source.width, height: A.source.height },
    speech_start: A.speech_start,
    speech_end: A.speech_end,
    base_lufs: A.base_lufs,
    beats: A.beats.map((b) => ({ id: b.id, dur: b.dur, pause_after: b.pause_after })),
    tokens: A.tokens.map((t) => ({ beat: t.beat })),
    anchors: A.anchors,
  };
}
