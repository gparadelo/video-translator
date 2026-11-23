// The analysis of the original voiceover: a port of the old Python pipeline's cmd_analyze (steps 1-4 and its sanity check),
// split_beats, script_from_words, norm and ISO3_TO_2. It ties every word of the transcript to its time in the
// voiceover (from ElevenLabs' forced alignment), every cut of the video to a word, and writes the beats with their
// {n} markers: analysis.json, format 1 (vt.portable_analysis; lib/produce/analysis.ts reads it). Pure (no I/O):
// lib/prepare/steps.ts runs it in the align route. test/prepare-parity.test.ts compares it with the old Python pipeline's.

import type { Anchor } from "../pipeline/inputs";
import { pyFormat, pyIntList, pyLen, pyRoundTo, pyStrip, words as pyWords } from "../pipeline/py";
import { ANALYSIS_FORMAT, type Analysis, type AnalysisBeat } from "../produce/analysis";
import { SequenceMatcher } from "./difflib";

/** Python's \s (str.isspace) as a character class body; the same set lib/pipeline/py.ts uses. */
const S = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PARAS = new RegExp(`\\n[${S}]*\\n`, "u");
const SENTENCES = new RegExp(`(?<=[.!?…])[${S}]+`, "u");
const SPACES = new RegExp(`[${S}]+`, "gu");

/** vt.split_beats: paragraphs; one paragraph -> its lines; one line -> its sentences. Runs of spaces become one. */
export function splitBeats(text: string): string[] {
  text = text.replaceAll("\r", "");
  let paras = text.split(PARAS).map(pyStrip).filter(Boolean);
  if (paras.length === 1) {
    const lines = paras[0].split("\n").map(pyStrip).filter(Boolean);
    paras = lines.length > 1 ? lines : paras[0].split(SENTENCES).map(pyStrip).filter(Boolean);
  }
  return paras.map((p) => p.replace(SPACES, " "));
}

/** A word of ElevenLabs' speech-to-text (words with timestamps_granularity "word"). */
export type SttWord = { text?: string | null; start: number; end: number; type?: string };

/**
 * vt.script_from_words: one beat per sentence, and a silence of `pause` seconds or more mid-sentence starts a new
 * beat too.
 */
export function scriptFromWords(words: SttWord[], pause: number): string {
  const beats: string[] = [];
  let cur = "";
  let lastEnd: number | null = null;
  for (const w of words) {
    const t = pyStrip(w.text ?? "");
    if ((w.type ?? "word") !== "word" || !t) continue;
    if (cur && lastEnd !== null) {
      const gap = w.start - lastEnd;
      if (/[.!?…]$/u.test(cur) || gap >= pause) {
        beats.push(cur);
        cur = "";
      }
    }
    cur = pyStrip(`${cur} ${t}`);
    lastEnd = w.end;
  }
  if (cur) beats.push(cur);
  return beats.join("\n\n") + "\n";
}

/** vt.norm: lower case, accents off, only letters, digits and _ (Python's \w). */
export const norm = (w: string) => w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}_]/gu, "");

/** vt.ISO3_TO_2: ElevenLabs reports ISO 639-3 language codes; the app uses the 2-letter ones. */
export const ISO3_TO_2: Record<string, string> = {
  spa: "es", eng: "en", deu: "de", ger: "de", fra: "fr", fre: "fr", ita: "it", nld: "nl", dut: "nl", por: "pt",
  pol: "pl", swe: "sv", dan: "da", nor: "no", nob: "no", fin: "fi", tur: "tr", jpn: "ja", kor: "ko", zho: "zh",
  chi: "zh", cmn: "zh", ara: "ar", hin: "hi", rus: "ru", ukr: "uk", ces: "cs", cze: "cs", ron: "ro", rum: "ro",
  ell: "el", gre: "el", hun: "hu", cat: "ca", glg: "gl",
};
export const lang2 = (code: string | null | undefined) => ISO3_TO_2[code ?? ""] ?? (code ?? "");

/** A word of ElevenLabs' forced alignment. */
export type AlignedWord = { text: string; start: number; end: number };
export type Alignment = { words: AlignedWord[]; loss?: number };

/** What the video itself gave (lib/prepare/media.ts: measured in the browser). */
export type VideoMeasures = {
  dur: number;
  fps: number;
  width: number;
  height: number;
  base_lufs: number;
};

type Token = { beat: number; text: string; cs: number; start?: number; end?: number; interp?: boolean };

/**
 * vt.cmd_analyze from the script's beats, the forced alignment of the voiceover to them, and the cuts: the
 * analysis as vt.portable_analysis writes it. Throws when the script has no words.
 */
export function analyzeVoiceover(o: { beats: string[]; alignment: Alignment; cuts: number[]; video: VideoMeasures; lang: string }): Analysis {
  const { beats, alignment: al, cuts, video, lang } = o;
  const dur = video.dur;
  const warnings: string[] = [];
  const tokens: Token[] = [];
  beats.forEach((bt, bi) => {
    const chars = Array.from(bt);
    for (const m of pyWords(chars)) tokens.push({ beat: bi, text: chars.slice(m.start, m.end).join(""), cs: m.start });
  });
  if (!tokens.length) throw new Error("the transcript has no words");

  // 1. tie the script's words to the aligner's
  const words = (al.words ?? []).filter((w) => norm(w.text));
  const sm = new SequenceMatcher(tokens.map((t) => norm(t.text)), words.map((w) => norm(w.text)), false);
  for (const [a, b, size] of sm.getMatchingBlocks()) {
    for (let k = 0; k < size; k++) Object.assign(tokens[a + k], { start: words[b + k].start, end: words[b + k].end });
  }
  const matched = tokens.filter((t) => t.start !== undefined).length;
  tokens.forEach((t, i) => { // words the aligner didn't match: spread them between their neighbours
    if (t.start !== undefined) return;
    let prevEnd = 0.0;
    for (let j = i - 1; j >= 0; j--) if (tokens[j].end !== undefined) { prevEnd = tokens[j].end!; break; }
    let nxt: number | null = null;
    for (let j = i + 1; j < tokens.length; j++) if (tokens[j].start !== undefined) { nxt = j; break; }
    const nxtStart = nxt !== null ? tokens[nxt].start! : dur;
    const nMissing = (nxt !== null ? nxt : tokens.length) - i;
    const step = (nxtStart - prevEnd) / (nMissing + 1);
    Object.assign(t, { start: prevEnd + step * 0.5, end: prevEnd + step, interp: true });
  });
  if (matched < 0.8 * tokens.length) {
    warnings.push(`only ${matched}/${tokens.length} script words matched the audio - is script.txt the exact voiceover text?`);
  }

  // 3. anchor every cut to the word being spoken
  const s0 = tokens[0].start!, s1 = tokens[tokens.length - 1].end!;
  const anchors: Anchor[] = [];
  cuts.forEach((t, k) => {
    const id = k + 1;
    if (t < s0) anchors.push({ id, t, kind: "lead", frac: s0 > 0 ? t / s0 : 0 });
    else if (t >= s1) anchors.push({ id, t, kind: "tail", off: t - s1 });
    else {
      let i = -1;
      for (let j = 0; j < tokens.length; j++) if (tokens[j].start! <= t) i = j;
      const tk = tokens[i];
      if (t <= tk.end! || i === tokens.length - 1) {
        const span = Math.max(1e-3, tk.end! - tk.start!);
        anchors.push({ id, t, kind: "in", token: i, frac: Math.min(1.0, (t - tk.start!) / span) });
      } else {
        const gap = Math.max(1e-3, tokens[i + 1].start! - tk.end!);
        anchors.push({ id, t, kind: "gap", token: i + 1, frac: (t - tk.end!) / gap });
      }
    }
  });

  // 4. beats with marker text
  const marksAt = new Map<number, number[]>();
  for (const an of anchors) {
    if (an.kind === "in" || an.kind === "gap") marksAt.set(an.token!, [...(marksAt.get(an.token!) ?? []), an.id]);
  }
  const outBeats: (AnalysisBeat & { start: number; end: number })[] = beats.map((bt, bi) => {
    const chars = Array.from(bt);
    const idx = tokens.flatMap((t, i) => (t.beat === bi ? [i] : []));
    let marked = "", pos = 0;
    for (const i of idx) {
      const cs = tokens[i].cs;
      marked += chars.slice(pos, cs).join("") + (marksAt.get(i) ?? []).map((m) => `{${m}}`).join("");
      pos = cs;
    }
    marked += chars.slice(pos).join("");
    const st = tokens[idx[0]].start!, en = tokens[idx[idx.length - 1]].end!;
    const nxt = idx[idx.length - 1] + 1 < tokens.length ? tokens[idx[idx.length - 1] + 1].start! : null;
    return { id: bi + 1, text: bt, marked, start: pyRoundTo(st, 3), end: pyRoundTo(en, 3), dur: pyRoundTo(en - st, 3),
             pause_after: nxt ? pyRoundTo(nxt - en, 3) : 0.0 }; // `if nxt`: a next word at exactly 0 s counts as none
  });

  // a beat spoken impossibly fast or slow means the script doesn't match the voiceover
  const rate = (b: AnalysisBeat) => pyLen(b.text) / Math.max(0.05, b.dur);
  const rates = outBeats.map(rate).sort((x, y) => x - y);
  const med = rates[Math.floor(rates.length / 2)];
  const odd = outBeats.filter((b) => !(med / 2.5 < rate(b) && rate(b) < med * 2.5)).map((b) => b.id);
  const loss = al.loss ?? 0;
  if (odd.length || loss > 1.5) {
    warnings.push(`script.txt does not seem to match the voiceover (alignment loss ${pyFormat(loss, 2)}; ` +
      `suspicious beats: ${odd.length ? pyIntList(odd) : "none"}). Check that the beats are in the order they are ` +
      "spoken and the wording matches, then re-run analyze.");
  }

  return {
    format: ANALYSIS_FORMAT,
    base_lang: lang,
    video: { dur, fps: video.fps },
    source: { width: video.width, height: video.height },
    speech_start: s0,
    speech_end: s1,
    base_lufs: video.base_lufs,
    beats: outBeats.map((b) => ({ id: b.id, text: b.text, marked: b.marked, dur: b.dur, pause_after: b.pause_after })),
    tokens: tokens.map((t) => ({ beat: t.beat })),
    anchors,
    warnings,
  };
}

/**
 * The cuts as cmd_analyze reads them back from cuts.txt (written with 3 decimals) on every analysis after the first
 * one: after the name check changed the transcript, and when an edited transcript is timed again.
 */
export const cutsAsSaved = (cuts: number[]) => cuts.map((t) => Number(pyFormat(t, 3))).sort((a, b) => a - b);
