// The spelling of names in a fresh transcript, checked by Claude: a port of the old Python pipeline's fix_names (NAMES_SYSTEM,
// NAMES_SCHEMA, the prompt, and how the answer is used). The person's "Names in the video" text (jobs.reference)
// is the reference, as the worker's reference.txt was. Server only (the names route, the person's own Claude key).

import { pyStrip } from "../pipeline/py";
import { claudeJson, langName, type ClaudeClient, type ClaudeUsage } from "../produce/translate";
import { ProduceError } from "../produce/errors";
import { stringRatio } from "./difflib";

export const NAMES_SYSTEM = `You proofread automatic transcripts of short product-video voiceovers. Fix only the spelling \
of names the speech-to-text got wrong: brands, products, models, people, places (e.g. "Nano Leaf" -> "Nanoleaf"). \
Use the reference text when there is one; otherwise fix only names you are sure of. Never change any other word, \
the wording, the word order, the punctuation or the beats: the text has to keep saying exactly what was spoken.`;

export const NAMES_SCHEMA = {
  type: "object",
  properties: { beats: { type: "array", items: { type: "string" } }, changes: { type: "array", items: { type: "string" } } },
  required: ["beats", "changes"],
  additionalProperties: false,
};

/** vt.fix_names' message: the beats, numbered, and the reference text (the person's names, stripped). */
export function namesPrompt(beats: string[], baseLang: string, reference: string | null): string {
  const ref = pyStrip(reference ?? "");
  return `Transcript (${langName(baseLang)}), one beat per line:\n\n` + beats.map((b, i) => `${i + 1}. ${b}`).join("\n") +
    (ref ? `\n\nReference text (spelling of names):\n\n${ref}` : "\n\nNo reference text.") +
    "\n\nReturn every beat (without the numbers), corrected or not, and a short list of what you changed " +
    '(e.g. "Nano Leaf -> Nanoleaf").';
}

const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACES = new RegExp(`[${PY_SPACE}]+`, "gu");

export type NamesResult = {
  /** the transcript to time: the corrected beats, or the original ones */
  script: string;
  /** what Claude changed (vt.fix_names' return value: [] when nothing was changed) */
  changed: string[];
  /** Claude changed more than names: the transcript was kept as it was (the old Python pipeline only logs this) */
  refused: boolean;
};

/** How vt.fix_names uses Claude's answer for `beats` (the transcript's beats, as split_beats has them). */
export function applyNames(beats: string[], answer: { beats: string[]; changes: string[] }): NamesResult {
  const keep = { script: beats.join("\n\n") + "\n", changed: [] as string[] };
  const next = answer.beats.map((b) => pyStrip(b.replace(SPACES, " ")));
  if (next.length !== beats.length || beats.some((a, i) => stringRatio(a.toLowerCase(), next[i].toLowerCase()) < 0.8)) {
    return { ...keep, refused: true };
  }
  if (next.every((b, i) => b === beats[i])) return { ...keep, refused: false };
  return { script: next.join("\n\n") + "\n", changed: answer.changes.length ? answer.changes : ["names corrected"], refused: false };
}

/** One Claude call: the name check of `beats`. */
export async function checkNames(client: ClaudeClient, beats: string[], baseLang: string, reference: string | null):
  Promise<{ result: NamesResult; usage: ClaudeUsage }> {
  const { data, usage } = await claudeJson(client, NAMES_SYSTEM, NAMES_SCHEMA, [{ role: "user", content: namesPrompt(beats, baseLang, reference) }]);
  const d = data as { beats?: unknown; changes?: unknown } | null;
  if (!Array.isArray(d?.beats) || !d.beats.every((b) => typeof b === "string") ||
      !Array.isArray(d.changes) || !d.changes.every((c) => typeof c === "string")) {
    throw new ProduceError("Claude's answer wasn't in the expected form - try again", { retry: true });
  }
  const changes = (d.changes as string[]).slice(0, 50).map((c) => c.slice(0, 300));
  return { result: applyNames(beats, { beats: d.beats as string[], changes }), usage };
}
