// The translation of one language with Claude: a port of the old Python pipeline's translate path (TRANSLATE_SYSTEM,
// SCRIPT_SCHEMA, brief_table, check_script, claude_json, write_lang_script, translate_lang, refit_lang). Prompts,
// schema, model and checks are the old Python pipeline's to the character (test/produce-parity.test.ts compares
// with its frozen requests to the same fake Claude). Server only: it runs in the produce routes, on the person's own Claude key.

import Anthropic from "@anthropic-ai/sdk";
import type { Plan } from "../pipeline/plan";
import { pyFloatRepr, pyFormat, pyIntList, pyLen, pyRoundTo, pyStrip, stripMarkers } from "../pipeline/py";
import type { Analysis, AnalysisBeat } from "./analysis";
import { CLAUDE } from "./config";
import { ProduceError, retryAfter } from "./errors";

export const TRANSLATE_SYSTEM = `You translate the voiceover of short-form product videos (Instagram/TikTok style) so it can be \
re-voiced in another language and the video re-timed to it.

The voiceover is split into beats. Some words carry markers like {3}: each marker is a video cut that has to land \
on that word.

Rules:
- Return exactly the same beats, with the same ids and in the same order.
- Keep every {n} marker exactly once, directly in front of the word that carries the same meaning as in the \
original. Never put a marker in a different beat than the original. Keep markers in increasing order when the \
grammar allows it. Markers that are adjacent in the original (like {14}{15}) stay adjacent.
- Fit the timing: each beat should take about as long to say as the original. You get the seconds and character \
count of each original beat and the original speaking rate. Prefer natural, spoken, short-form-video phrasing \
over a literal translation; shorten when the target language runs long (German and French usually do).
- Match the register of the original (informal stays informal, formal stays formal). Never translate brand or \
product names.
- speed is the voice speed for a beat (0.7 to 1.2, null = default). Use it only when a beat can't be shortened \
or lengthened without losing meaning; rewriting the text comes first.`;

/** vt.LANG_NAMES */
export const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian", nl: "Dutch", pt: "Portuguese",
  pl: "Polish", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", tr: "Turkish", ja: "Japanese",
  ko: "Korean", zh: "Chinese", ar: "Arabic", hi: "Hindi", ru: "Russian", uk: "Ukrainian", cs: "Czech", ro: "Romanian",
  el: "Greek", hu: "Hungarian", ca: "Catalan", gl: "Galician",
};

export const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" }, speed: { anyOf: [{ type: "number" }, { type: "null" }] } },
        required: ["id", "text", "speed"],
        additionalProperties: false,
      },
    },
  },
  required: ["beats"],
  additionalProperties: false,
};

export type Message = { role: "user" | "assistant"; content: string };
/** A beat as Claude returns it. */
export type ClaudeBeat = { id: number; text: string; speed: number | null };
/** A beat of the translation (work/<lang>/script.json, as vt.write_lang_script writes it). */
export type ScriptBeat = { id: number; text: string; speed?: number };

/** vt.lang_name */
export const langName = (code: string) => `${LANG_NAMES[code] ?? code} (${code})`;

const MARK = /\{(\d+)\}/g;
const marks = (s: string) => Array.from(s.matchAll(MARK), (m) => Number(m[1]));

/** vt.brief_table */
export function briefTable(beats: AnalysisBeat[]): string {
  const rate = beats.reduce((n, b) => n + pyLen(b.text), 0) / beats.reduce((n, b) => n + b.dur, 0);
  const rows = [`Original speaking rate: ${pyFormat(rate, 1)} characters/second.`, "",
    "| beat | seconds | chars | text with markers |", "|---|---|---|---|"];
  for (const b of beats) rows.push(`| ${b.id} | ${pyFormat(b.dur, 2)} | ${pyLen(b.text)} | ${b.marked} |`);
  return rows.join("\n");
}

/** vt.check_script: problems that make a translation unusable (wrong beats, markers lost, duplicated or moved). */
export function checkScript(base: AnalysisBeat[], beats: { id: number; text: string }[]): string[] {
  const want = base.map((b) => b.id);
  if (beats.length !== want.length || beats.some((b, i) => b.id !== want[i])) {
    return [`the beats must have ids ${pyIntList(want)}, in that order`];
  }
  const errs: string[] = [];
  base.forEach((bb, i) => {
    const b = beats[i];
    const w = marks(bb.marked);
    const got = marks(b.text);
    const lost = w.filter((m) => !got.includes(m));
    const extra = [...new Set(got.filter((m) => got.filter((x) => x === m).length > 1 || !w.includes(m)))].sort((x, y) => x - y);
    const list = (ms: number[]) => ms.map((m) => `{${m}}`).join(", ");
    if (lost.length) errs.push(`beat ${b.id} is missing marker(s) ${list(lost)}`);
    if (extra.length) errs.push(`beat ${b.id} has marker(s) ${list(extra)} that don't belong there or appear more than once`);
    if (!pyStrip(stripMarkers(b.text).clean.join(""))) errs.push(`beat ${b.id} is empty`);
  });
  return errs;
}

/** vt.write_lang_script: the beats as script.json keeps them (text stripped, speed within 0.7-1.2, 2 decimals). */
export function langScript(beats: ClaudeBeat[]): ScriptBeat[] {
  return beats.map((b) => {
    const d: ScriptBeat = { id: b.id, text: pyStrip(b.text) };
    if (b.speed !== null && b.speed !== undefined) d.speed = pyRoundTo(Math.max(0.7, Math.min(1.2, Number(b.speed))), 2);
    return d;
  });
}

/** vt.translate_lang's first message. */
export const translatePrompt = (A: Analysis, lang: string) =>
  `Translate this ${langName(A.base_lang)} voiceover into ${langName(lang)}.\n\n${briefTable(A.beats)}`;

/** vt.refit_lang's message: rewrite the beats the plan flagged (`plan` is built from `script` as voiced). */
export function refitPrompt(A: Analysis, lang: string, script: ScriptBeat[], plan: Pick<Plan, "beats" | "flags">): string {
  const flagged = [...new Set(plan.flags.flatMap((f) => (f.beat !== null ? [f.beat] : [])))].sort((x, y) => x - y);
  const rows = ["| beat | original s | voiced s | speed | text |", "|---|---|---|---|---|"];
  const n = Math.min(script.length, plan.beats.length);
  for (let i = 0; i < n; i++) {
    const sb = script[i], pb = plan.beats[i];
    rows.push(`| ${sb.id} | ${pyFormat(pb.base_dur, 2)} | ${pyFormat(pb.dur, 2)} | ${sb.speed ? pyFloatRepr(sb.speed) : "default"} | ${sb.text} |`);
  }
  return `Here is the original ${langName(A.base_lang)} voiceover:\n\n${briefTable(A.beats)}\n\n` +
    `and its ${langName(lang)} translation after voicing it (seconds as spoken):\n\n` + rows.join("\n") +
    "\n\nFitting the video to this voice left these problems:\n- " + plan.flags.map((f) => f.msg).join("\n- ") +
    `\n\nRewrite beat(s) ${flagged.join(", ") || "as needed"} to fix them: shorter or longer ` +
    "text first, speed only for the last bit. Return all beats; leave the others exactly as they are.";
}

/** vt.ask_until_valid's message after a translation with problems. */
export const fixPrompt = (errs: string[]) => "Fix these problems and return all beats again:\n- " + errs.join("\n- ");

/** The part of the Anthropic client a translation uses (a fake one in tests). */
export type ClaudeClient = Pick<Anthropic, "beta">;

export type ClaudeUsage = { model: string; input_tokens: number; output_tokens: number };

/**
 * vt.claude_json: one Claude call whose answer is JSON matching `schema`. Returns the parsed answer, the assistant
 * message to append when asking again, and the usage. Errors come back as ProduceError: retry for the passing
 * ones (busy, overloaded, connection), a plain message for the rest.
 */
export async function claudeJson(client: ClaudeClient, system: string, schema: object, messages: Message[]): Promise<{ data: unknown; reply: Message; usage: ClaudeUsage }> {
  let r;
  try {
    r = await client.beta.messages.create({
      model: CLAUDE.model,
      max_tokens: CLAUDE.max_tokens,
      system,
      messages,
      output_config: { effort: CLAUDE.effort, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      betas: CLAUDE.betas,
      fallbacks: "default",
    });
  } catch (err) {
    throw claudeError(err);
  }
  if (r.stop_reason === "refusal") {
    const category = (r as { stop_details?: { category?: string } | null }).stop_details?.category ?? null;
    throw new ProduceError(`Claude declined this request (${category ?? "None"})`);
  }
  if (r.stop_reason === "max_tokens") {
    throw new ProduceError("Claude's answer was cut off (max_tokens) - the script may be too long for one call");
  }
  const text = r.content.find((b) => b.type === "text")?.text;
  if (text === undefined) throw new ProduceError("Claude's answer had no text - try again", { retry: true });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProduceError("Claude's answer wasn't readable - try again", { retry: true });
  }
  const u = r.usage;
  return { data, reply: { role: "assistant", content: text }, usage: { model: r.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens } };
}

/** vt.claude_script: a translation call. Returns the beats, the assistant message to append, and the usage. */
export async function claudeScript(client: ClaudeClient, messages: Message[]): Promise<{ beats: ClaudeBeat[]; reply: Message; usage: ClaudeUsage }> {
  const { data, reply, usage } = await claudeJson(client, TRANSLATE_SYSTEM, SCRIPT_SCHEMA, messages);
  const beats = (data as { beats?: unknown } | null)?.beats;
  if (!Array.isArray(beats) || !beats.every((b) => b && Number.isInteger(b.id) && typeof b.text === "string" &&
      (b.speed === null || b.speed === undefined || (typeof b.speed === "number" && Number.isFinite(b.speed))))) {
    throw new ProduceError("Claude's answer wasn't in the expected form - try again", { retry: true });
  }
  return { beats: beats.map((b) => ({ id: b.id, text: b.text, speed: b.speed ?? null })), reply, usage };
}

/** A Claude API error as the person should see it (vt.claude_json's messages, and which ones pass by themselves). */
export function claudeError(err: unknown): ProduceError {
  if (err instanceof ProduceError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProduceError("the Claude API rejected your Claude API key (401) - check it in Settings", { status: 409 });
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ProduceError(`your Claude API key isn't allowed to do this (403): ${err.message}`, { status: 409 });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProduceError("Claude is busy (too many requests) - trying again", { status: 429, retry: true, after: retryAfter(err.headers?.get?.("retry-after")) });
  }
  if (err instanceof Anthropic.APIConnectionError) { // includes timeouts
    return new ProduceError("couldn't reach the Claude API - trying again", { retry: true });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const msg = err.message ?? "";
    if (status >= 500 || status === 408 || status === 409) {
      return new ProduceError(`the Claude API is having problems (${status}) - trying again`, { retry: true });
    }
    if (/credit balance|billing|insufficient/i.test(msg)) {
      return new ProduceError("your Claude API account is out of credits - add credits at platform.claude.com (Billing), then try again", { status: 409 });
    }
    return new ProduceError(`Claude API error (${status}): ${msg}`);
  }
  return new ProduceError(`the translation failed: ${(err as Error)?.message ?? err}`, { retry: true });
}
