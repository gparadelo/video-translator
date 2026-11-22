// Fake Claude and ElevenLabs APIs for the tests: no paid calls. Both are plain HTTP servers that answer the way
// the real APIs do (the shapes scripts/vt.py and lib/produce read), deterministically: the same request always
// gets the same answer, so vt.py (Python SDK, requests) and the web app (TypeScript SDK, fetch) can be run against
// them one after the other and their requests and results compared. Every request is recorded; failures can be
// queued (429, 529, 401 ...) to test the retries and the messages.
//
//   const m = await startMocks();   m.claudeUrl, m.elevenUrl, m.requests, m.fail("claude", {status: 529}), m.close()
//
// The fake Claude "translates" by rewriting each word (longer for German, so beats run long and get flagged),
// drops a cut marker in its first German answer (so check_script asks again), and in a rewrite shortens or
// lengthens exactly the beats it was asked to (in Italian its rewrites never help), and in a name check fixes
// "Nano Leaf" when the reference spells it "Nanoleaf". The fake ElevenLabs voices each word as a tone burst (an MP3
// made with ffmpeg's libmp3lame, LAME header like ElevenLabs' files) with a per-character alignment; its
// speech-to-text and forced alignment take a multipart upload (the file must be audio ffprobe can read; it's
// recorded with what ffprobe says of it) and "hear" the words set with setSpeech (by default test/videos.mjs's
// SPOKEN, the tone bursts of the test videos' voiceover). Forced alignment gives words that weren't said a few
// milliseconds each and a higher loss, so edits that change the words make vt.cmd_analyze warn.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPOKEN } from "./videos.mjs";

const SR = 44100;

const sha = (s) => createHash("sha1").update(s).digest("hex");

/** Parse the brief table of a translate or refit prompt: rows "| id | seconds | chars | marked |". */
function briefRows(prompt) {
  const rows = [];
  const part = prompt.split("\n\nand its ")[0];
  for (const line of part.split("\n")) {
    const m = /^\| (\d+) \| ([\d.]+) \| (\d+) \| (.*) \|$/.exec(line);
    if (m) rows.push({ id: Number(m[1]), dur: Number(m[2]), marked: m[4] });
  }
  return rows;
}

const SUFFIX = { de: "ungen", fr: "eux", es: "o", it: "issimo", nl: "en", pt: "ão", ja: "ー" };

/** One word "translated": markers kept in front, letters changed, longer or shorter by language. */
function fakeWord(w, lang, salt) {
  const m = /^((?:\{\d+\})*)(.*)$/s.exec(w);
  const marks = m[1], word = m[2];
  if (!word) return marks;
  const h = parseInt(sha(word + lang + salt).slice(0, 6), 16);
  const core = word.replace(/[aeiou]/g, (c) => ({ a: "ä", e: "é", i: "î", o: "ö", u: "ü" })[c] ?? c);
  const extra = lang === "de" ? (h % 3 === 0 ? "schaft" : SUFFIX.de) : lang === "it" || h % 4 === 0 ? (SUFFIX[lang] ?? "") : "";
  return marks + core + extra;
}

function translateBeats(rows, lang) {
  return rows.map((r) => {
    const words = r.marked.split(" ").map((w, k) => fakeWord(w, lang, k));
    const h = parseInt(sha(`${r.id}${lang}`).slice(0, 4), 16);
    // some beats get a speed: in range, out of range (clamped to 0.7-1.2), with more decimals (rounded to 2)
    const speed = h % 5 === 0 ? 1.08 : h % 7 === 0 ? 1.333 : h % 11 === 0 ? 0.6 : null;
    return { id: r.id, text: words.join(" ") + (h % 3 === 0 ? " — “ok”" : ""), speed };
  });
}

/**
 * A rewrite: the current translation's rows "| id | original s | voiced s | speed | text |", flagged beats changed.
 * Italian rewrites change nothing, so its flags stay and every round of rewrites is used up.
 */
function rewriteBeats(prompt, lang) {
  const flagged = /Rewrite beat\(s\) ([\d, ]+) to fix them/.exec(prompt)?.[1].split(", ").map(Number) ?? [];
  const after = prompt.split("translation after voicing it (seconds as spoken):\n\n")[1] ?? "";
  const out = [];
  for (const line of after.split("\n")) {
    const m = /^\| (\d+) \| ([\d.]+) \| ([\d.]+) \| ([^|]+) \| (.*) \|$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]), orig = Number(m[2]), voiced = Number(m[3]);
    const speed = m[4] === "default" ? null : Number(m[4]);
    let text = m[5];
    if (flagged.includes(id) && lang !== "it") {
      const words = text.split(" ");
      if (voiced > orig) { // too long: drop unmarked words from the end, shorten the rest
        const keep = words.filter((w, k) => /^\{/.test(w) || k < Math.max(1, Math.ceil(words.length * 0.6)));
        text = keep.map((w) => w.replace(/(ungen|schaft)$/, "")).join(" ");
        out.push({ id, text, speed: speed ? Math.min(1.2, speed + 0.05) : 1.1 });
      } else {
        out.push({ id, text: `${text} also`, speed: 0.95 });
      }
    } else out.push({ id, text, speed });
  }
  return out;
}

/**
 * vt.fix_names' request: "Transcript (...), one beat per line:\n\n1. ...\n2. ...", then the reference text. The fake
 * fixes "Nano Leaf" to "Nanoleaf" when the reference spells it so, and with "REWRITE" in the transcript it changes
 * far more than names (so the answer must be refused).
 */
function namesAnswer(prompt) {
  const [, rest = ""] = prompt.split(", one beat per line:\n\n");
  const lines = rest.split("\n\n")[0].split("\n").map((l) => l.replace(/^\d+\. /, ""));
  const ref = /Reference text \(spelling of names\):\n\n([\s\S]*?)\n\nReturn every beat/.exec(prompt)?.[1] ?? "";
  if (rest.includes("REWRITE")) return { beats: lines.map((l) => `Something else entirely ${l.length}`), changes: ["rewrote it"] };
  if (ref.includes("Nanoleaf") && lines.some((l) => l.includes("Nano Leaf"))) {
    return { beats: lines.map((l) => l.replaceAll("Nano Leaf", "Nanoleaf")), changes: ["Nano Leaf -> Nanoleaf"] };
  }
  return { beats: lines, changes: [] };
}

/** The fake Claude: the beats for one request (stateless). */
export function fakeClaudeAnswer(body) {
  const first = body.messages?.[0]?.content ?? "";
  if (first.startsWith("Transcript (")) return namesAnswer(first);
  const lang = /into [^(]*\((\w+)\)\./.exec(first)?.[1] ?? /and its [^(]*\((\w+)\) translation/.exec(first)?.[1] ?? "xx";
  if (first.startsWith("Translate this")) {
    const beats = translateBeats(briefRows(first), lang);
    // the first German answer loses a marker and the second duplicates one: check_script makes Claude try again
    const tries = body.messages.length;
    if (lang === "de" && tries < 5) {
      const i = beats.findIndex((b) => /\{\d+\}/.test(b.text));
      if (i >= 0 && tries === 1) beats[i] = { ...beats[i], text: beats[i].text.replace(/\{\d+\}/, "") };
      if (i >= 0 && tries === 3) beats[i] = { ...beats[i], text: beats[i].text.replace(/(\{\d+\})/, "$1$1") };
    }
    // "fr" with "ALWAYS-BROKEN" in the original: never right (the language fails after 3 tries)
    if (first.includes("ALWAYS-BROKEN")) return { beats: beats.map((b) => ({ ...b, text: b.text.replace(/\{\d+\}/g, "") })) };
    return { beats };
  }
  if (first.startsWith("Here is the original")) return { beats: rewriteBeats(first, lang) };
  return { beats: [] };
}

/** One fake voice clip: a tone burst per word, MP3 (libmp3lame, 128k, 44.1 kHz mono) and its alignment. */
function fakeVoice(dir, text, speed) {
  const chars = Array.from(text);
  const rate = 0.062 / speed;
  let t = 0.06;
  const st = [], en = [], spans = [];
  let wordStart = null;
  for (const c of chars) {
    const d = c === " " ? 0.07 / speed : rate;
    if (c !== " " && wordStart === null) wordStart = t;
    if (c === " " && wordStart !== null) {
      spans.push([wordStart, t]);
      wordStart = null;
    }
    st.push(Math.round(t * 1000) / 1000);
    t += d;
    en.push(Math.round(t * 1000) / 1000);
  }
  if (wordStart !== null) spans.push([wordStart, t]);
  // sometimes less silence at the end than the plan's 0.1 s clip tail: then the clip's length counts
  const dur = t + (parseInt(sha(text).slice(4, 6), 16) % 3 === 0 ? 0.03 : 0.18);
  const env = spans.map(([a, b]) => `between(t,${a.toFixed(4)},${b.toFixed(4)})`).join("+") || "0";
  const freq = 180 + (parseInt(sha(text).slice(0, 4), 16) % 300);
  const out = join(dir, `${sha(`${text}|${speed}`)}.mp3`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    `aevalsrc='0.3*(${env})*sin(2*PI*${freq}*t)':s=${SR}:d=${dur.toFixed(4)}`,
    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", out]);
  const mp3 = readFileSync(out);
  const alignment = { characters: chars, character_start_times_seconds: st, character_end_times_seconds: en };
  return { audio_base64: mp3.toString("base64"), alignment, normalized_alignment: alignment };
}

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  });
}

function readBuffer(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });
}

/** multipart/form-data: the text fields, and the file (name, type, bytes). */
function parseMultipart(buf, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const fields = {};
  let file = null;
  let at = buf.indexOf(sep);
  while (at >= 0) {
    const next = buf.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = buf.subarray(at + sep.length + 2, next - 2); // after CRLF, before CRLF
    const head = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, head).toString("utf8");
    const data = part.subarray(head + 4);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    if (filename !== undefined) file = { field: name, name: filename, type: /content-type: *([^\r\n]+)/i.exec(headers)?.[1] ?? "", data };
    else if (name) fields[name] = data.toString("utf8");
    at = next;
  }
  return { fields, file };
}

/** ffprobe's view of an uploaded audio file (null when it isn't one): what a real service would refuse. */
function probeAudio(dir, data) {
  const p = join(dir, `upload-${createHash("sha1").update(data).digest("hex").slice(0, 12)}`);
  writeFileSync(p, data);
  try {
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p], { encoding: "utf8" }));
    const a = j.streams?.find((s) => s.codec_type === "audio");
    return a ? { codec: a.codec_name, channels: a.channels, sample_rate: Number(a.sample_rate), duration: Number(j.format.duration), format: j.format.format_name } : null;
  } catch {
    return null;
  } finally {
    rmSync(p, { force: true });
  }
}

/** The voiceover the fake ElevenLabs "hears": words with times, and its language (ISO 639-3, as the API reports it). */
const DEFAULT_SPEECH = { language_code: "eng", words: SPOKEN.map(([text, start, end]) => ({ text, start, end })) };

/** Speech-to-text as /v1/speech-to-text answers with timestamps_granularity "word": words and the spaces between. */
function fakeTranscript(speech) {
  const words = [];
  speech.words.forEach((w, i) => {
    if (i) words.push({ text: " ", start: speech.words[i - 1].end, end: w.start, type: "spacing", speaker_id: "speaker_0", logprob: 0 });
    words.push({ text: w.text, start: w.start, end: w.end, type: "word", speaker_id: "speaker_0", logprob: -0.05 });
  });
  return { language_code: speech.language_code, language_probability: 0.98, text: speech.words.map((w) => w.text).join(" "), words };
}

const normWord = (w) => w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Forced alignment as /v1/forced-alignment answers: every word of `text` with its time, and a loss. Words that are
 * in the speech (in order) get its times; words that aren't are squeezed into a few milliseconds after the previous
 * one (so a beat of words that were never said looks impossibly fast), and they raise the loss.
 */
function fakeAlignment(speech, text) {
  const spoken = speech.words.map((w) => ({ ...w, key: normWord(w.text) }));
  const words = [];
  let j = 0, t = 0, missing = 0;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const key = normWord(raw);
    let k = j;
    while (k < spoken.length && spoken[k].key !== key) k++;
    // a name written as one word that was said as two ("Nanoleaf", heard "Nano Leaf")
    const found = k < spoken.length && k - j <= 3;
    if (key && !found && j + 1 < spoken.length && spoken[j].key + spoken[j + 1].key === key) {
      words.push({ text: raw, start: spoken[j].start, end: spoken[j + 1].end, loss: 0.3 });
      t = spoken[j + 1].end;
      j += 2;
    } else if (key && found) {
      words.push({ text: raw, start: spoken[k].start, end: spoken[k].end, loss: 0.1 });
      t = spoken[k].end;
      j = k + 1;
    } else {
      missing++;
      words.push({ text: raw, start: Math.round((t + 0.001) * 1000) / 1000, end: Math.round((t + 0.02) * 1000) / 1000, loss: 4 });
      t += 0.02;
    }
  }
  const characters = words.flatMap((w) => Array.from(w.text).map((c, i, a) => ({
    text: c, start: w.start + ((w.end - w.start) * i) / a.length, end: w.start + ((w.end - w.start) * (i + 1)) / a.length })));
  return { characters, words, loss: Math.round((0.2 + (3 * missing) / Math.max(1, words.length)) * 1000) / 1000 };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

export async function startMocks() {
  const dir = mkdtempSync(join(tmpdir(), "vt-mocks-"));
  const requests = [];
  const failures = { claude: [], eleven: [] };
  const voices = new Map();
  let speech = DEFAULT_SPEECH;

  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const claude = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url, "http://x");
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ service: "claude", path: url.pathname, query: url.search, headers: { ...req.headers }, body });
    const f = failures.claude.shift();
    if (f) return reply(res, f.status, f.body ?? { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, f.headers);
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return reply(res, 404, { type: "error", error: { type: "not_found_error", message: "no" } });
    const text = JSON.stringify(fakeClaudeAnswer(body));
    reply(res, 200, {
      id: `msg_${sha(raw).slice(0, 20)}`, type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: Math.ceil(text.length / 4) },
    }, { "request-id": "req_fake" });
  });

  const eleven = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const multipart = /multipart\/form-data/.test(req.headers["content-type"] ?? "");
    const raw = multipart ? await readBuffer(req) : await readBody(req);
    const form = multipart ? parseMultipart(raw, req.headers["content-type"]) : null;
    const body = form ? form.fields : raw ? JSON.parse(raw) : null;
    const audio = form?.file ? { name: form.file.name, type: form.file.type, size: form.file.data.length,
                                 sha1: createHash("sha1").update(form.file.data).digest("hex"), probe: probeAudio(dir, form.file.data) } : undefined;
    requests.push({ service: "eleven", path: url.pathname, query: url.search, headers: { ...req.headers }, body, audio });
    const f = failures.eleven.shift();
    if (f) return reply(res, f.status, f.body ?? { detail: { status: "system_busy", message: "busy" } }, f.headers);
    if (req.method === "POST" && (url.pathname === "/v1/speech-to-text" || url.pathname === "/v1/forced-alignment")) {
      if (!req.headers["xi-api-key"]) return reply(res, 401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
      if (!audio?.probe) return reply(res, 400, { detail: { status: "invalid_audio", message: "the file isn't audio" } });
      return reply(res, 200, url.pathname === "/v1/speech-to-text" ? fakeTranscript(speech) : fakeAlignment(speech, body.text ?? ""));
    }
    const m = /^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/.exec(url.pathname);
    if (req.method !== "POST" || !m) return reply(res, 404, { detail: "not found" });
    if (!req.headers["xi-api-key"]) return reply(res, 401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
    const k = `${body.text}|${body.voice_settings.speed}`;
    if (!voices.has(k)) voices.set(k, JSON.stringify(fakeVoice(dir, body.text, body.voice_settings.speed)));
    reply(res, 200, voices.get(k));
  });

  const [claudeUrl, elevenUrl] = await Promise.all([listen(claude), listen(eleven)]);
  return {
    claudeUrl, elevenUrl, requests,
    /** Queue answers for the next requests to one service: {status, body?, headers?}. */
    fail(service, ...answers) {
      failures[service].push(...answers);
    },
    /** What the fake speech-to-text and forced alignment "hear": {language_code, words: [{text, start, end}]}. */
    setSpeech(s) {
      speech = s ?? DEFAULT_SPEECH;
    },
    clear() {
      requests.length = 0;
      failures.claude.length = 0;
      failures.eleven.length = 0;
    },
    async close() {
      await Promise.all([new Promise((r) => claude.close(r)), new Promise((r) => eleven.close(r))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
