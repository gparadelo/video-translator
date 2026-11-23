// ElevenLabs speech-to-text and forced alignment of the original voiceover: the old Python pipeline's transcribe and
// forced_align (the same form fields and model), with the audio the browser extracted (prep/audio.*), read from
// storage on the server. Server only: the transcribe and align routes, on the person's own ElevenLabs key.

import { ELEVENLABS_API, STT_MODEL } from "../produce/config";
import { ProduceError } from "../produce/errors";
import { elevenLabsError } from "../produce/tts";
import type { Alignment, SttWord } from "./analyze";

export type Transcript = { language_code?: string | null; text?: string; words: SttWord[] };

type Opts = { fetchFn?: typeof fetch; api?: string; timeoutMs?: number };

type Form = { fields: [string, string][]; file: { data: Uint8Array; name: string; type: string } };

/**
 * multipart/form-data written out as Python's requests writes it. (FormData would turn the transcript's newlines into
 * CRLF, as browsers must; the old Python pipeline sends them as they are, and the beats are separated by them.)
 */
function multipart(form: Form): { body: Uint8Array; type: string } {
  const boundary = `----vt${crypto.randomUUID().replaceAll("-", "")}`;
  const enc = new TextEncoder();
  const esc = (s: string) => s.replace(/["\r\n]/g, (c) => encodeURIComponent(c));
  const parts: Uint8Array[] = [];
  for (const [name, value] of form.fields) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"\r\n\r\n${value}\r\n`));
  }
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${esc(form.file.name)}"\r\n` +
    `Content-Type: ${form.file.type}\r\n\r\n`), form.file.data, enc.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

async function post(what: string, permission: string, path: string, apiKey: string, form: Form, opts: Opts): Promise<unknown> {
  let r: Response;
  const { body, type } = multipart(form);
  try {
    r = await (opts.fetchFn ?? fetch)(`${opts.api ?? ELEVENLABS_API}${path}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": type },
      body: body as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 280_000),
    });
  } catch {
    throw new ProduceError(`couldn't reach ElevenLabs for the ${what} - trying again`, { retry: true });
  }
  const text = await r.text().catch(() => "");
  if (r.status !== 200) throw elevenLabsError(what === "transcription" ? "Transcription" : "Forced alignment", r.status, text, permission, undefined, r.headers.get("retry-after"));
  try {
    return JSON.parse(text);
  } catch {
    throw new ProduceError(`ElevenLabs' ${what} wasn't readable - trying again`, { retry: true });
  }
}

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);

/** vt.transcribe: POST /v1/speech-to-text (file, model_id, tag_audio_events "false", timestamps_granularity "word"). */
export async function transcribe(apiKey: string, audio: Uint8Array, name: string, type: string, opts: Opts = {}): Promise<Transcript> {
  const form: Form = {
    fields: [["model_id", STT_MODEL], ["tag_audio_events", "false"], ["timestamps_granularity", "word"]],
    file: { data: audio, name, type },
  };
  const d = (await post("transcription", "Speech to Text", "/v1/speech-to-text", apiKey, form, opts)) as Partial<Transcript> | null;
  if (!d || !Array.isArray(d.words) || !d.words.every((w) => w && num(w.start) && num(w.end))) {
    throw new ProduceError("ElevenLabs' transcription wasn't in the expected form - trying again", { retry: true });
  }
  return d as Transcript;
}

/** vt.forced_align: POST /v1/forced-alignment (file, text). */
export async function forcedAlign(apiKey: string, audio: Uint8Array, name: string, type: string, text: string, opts: Opts = {}): Promise<Alignment & Record<string, unknown>> {
  const form: Form = { fields: [["text", text]], file: { data: audio, name, type } };
  const d = (await post("forced alignment", "Forced Alignment", "/v1/forced-alignment", apiKey, form, opts)) as Partial<Alignment> | null;
  if (!d || !Array.isArray(d.words) || !d.words.every((w) => w && typeof w.text === "string" && num(w.start) && num(w.end))) {
    throw new ProduceError("ElevenLabs' forced alignment wasn't in the expected form - trying again", { retry: true });
  }
  return d as Alignment & Record<string, unknown>;
}
