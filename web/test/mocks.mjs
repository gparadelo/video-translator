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
// lengthens exactly the beats it was asked to (in Italian its rewrites never help). The fake ElevenLabs voices each word as a tone burst (an MP3 made
// with ffmpeg's libmp3lame, LAME header like ElevenLabs' files) with a per-character alignment.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** The fake Claude: the beats for one request (stateless). */
export function fakeClaudeAnswer(body) {
  const first = body.messages?.[0]?.content ?? "";
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

export async function startMocks() {
  const dir = mkdtempSync(join(tmpdir(), "vt-mocks-"));
  const requests = [];
  const failures = { claude: [], eleven: [] };
  const voices = new Map();

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
    const raw = await readBody(req);
    const url = new URL(req.url, "http://x");
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ service: "eleven", path: url.pathname, query: url.search, headers: { ...req.headers }, body });
    const f = failures.eleven.shift();
    if (f) return reply(res, f.status, f.body ?? { detail: { status: "system_busy", message: "busy" } }, f.headers);
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
