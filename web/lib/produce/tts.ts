// One beat's voice from ElevenLabs: a port of scripts/vt.py's tts_beat (the request body, the cache key, what
// is kept next to the clip) and api_error (what a refused request means). The request bodies and cache keys are
// vt.py's exactly (test/produce-parity.test.ts), so a clip vt.py made and one made here are the same file name.
// Server only: it runs in the produce route, on the person's own ElevenLabs key.

import { createHash } from "node:crypto";
import type { ClipMeta } from "../pipeline/inputs";
import { pyJsonDumps, pyStrip, stripMarkers } from "../pipeline/py";
import { ELEVENLABS, ELEVENLABS_API, KEY_PERMISSIONS } from "./config";
import { ProduceError, retryAfter } from "./errors";

export type TtsBody = {
  text: string;
  model_id: string;
  voice_settings: typeof ELEVENLABS.voice_settings;
  previous_text?: string;
  next_text?: string;
  language_code?: string;
};

/** Each beat's text as it is voiced: markers removed, stripped (vt.cmd_tts). */
export const voicedTexts = (beats: { text: string }[]) => beats.map((b) => pyStrip(stripMarkers(b.text).clean.join("")));

/** vt.tts_beat's request body for beat `i` of `texts` (voicedTexts), voiced at `speed` (null = the default). */
export function ttsBody(texts: string[], i: number, lang: string, speed: number | null | undefined, el = ELEVENLABS): TtsBody {
  const settings = { ...el.voice_settings };
  settings.speed = Math.max(0.7, Math.min(1.2, speed ? speed : (settings.speed ?? 1.0)));
  const body: TtsBody = { text: texts[i], model_id: el.model_id, voice_settings: settings };
  const prev = i ? texts[i - 1] : "";
  const next = i + 1 < texts.length ? texts[i + 1] : "";
  if (prev) body.previous_text = prev;
  if (next) body.next_text = next;
  if (!el.model_id.startsWith("eleven_multilingual_v2")) body.language_code = lang;
  return body;
}

/** vt.tts_beat's cache key: the clip's file name (without .mp3 / .json), the same for the same voice, format and request. */
export function ttsKey(voice: string, body: TtsBody, outputFormat = ELEVENLABS.output_format): string {
  return createHash("sha1").update(pyJsonDumps([voice, outputFormat, body]), "utf8").digest("hex").slice(0, 12);
}

export type Clip = { mp3: Uint8Array; meta: ClipMeta };

const MAX_MP3_BYTES = 10_000_000;

/**
 * One request to ElevenLabs' with-timestamps endpoint. Returns the clip and the meta vt.tts_beat keeps next to
 * it (tts/<key>.json). `fetchFn` and `api` are for tests (a fake ElevenLabs).
 */
export async function requestTts(apiKey: string, voice: string, body: TtsBody,
                                 opts: { fetchFn?: typeof fetch; api?: string; timeoutMs?: number } = {}): Promise<Clip> {
  const url = `${opts.api ?? ELEVENLABS_API}/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps` +
    `?output_format=${encodeURIComponent(ELEVENLABS.output_format)}`;
  let r: Response;
  try {
    r = await (opts.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 50_000),
    });
  } catch {
    throw new ProduceError("couldn't reach ElevenLabs - trying again", { retry: true });
  }
  const text = await r.text().catch(() => "");
  if (r.status !== 200) throw elevenLabsError("TTS", r.status, text, "Text to Speech", voice, r.headers.get("retry-after"));
  let d: { audio_base64?: unknown; alignment?: ClipMeta["alignment"]; normalized_alignment?: unknown };
  try {
    d = JSON.parse(text);
  } catch {
    throw new ProduceError("ElevenLabs' answer wasn't readable - trying again", { retry: true });
  }
  if (typeof d.audio_base64 !== "string" || !d.audio_base64) {
    throw new ProduceError("ElevenLabs sent no audio - trying again", { retry: true });
  }
  const mp3 = new Uint8Array(Buffer.from(d.audio_base64, "base64"));
  if (!mp3.length || mp3.length > MAX_MP3_BYTES) throw new ProduceError("ElevenLabs sent an unusable clip - trying again", { retry: true });
  return {
    mp3,
    meta: { text: body.text, speed: body.voice_settings.speed, alignment: d.alignment ?? null,
            normalized_alignment: d.normalized_alignment ?? null },
  };
}

/**
 * vt.api_error for the web app: what an ElevenLabs refusal means for the person. Busy (429) and server errors
 * pass by themselves (retry); a key without a permission, a rejected key, used-up credits or a missing voice need
 * the person.
 */
export function elevenLabsError(what: string, status: number, text: string, permission: string, voice?: string,
                                retryAfterHeader?: string | null): ProduceError {
  const lower = text.toLowerCase();
  if (status === 429 || status >= 500) {
    const what = lower.includes("concurrent") ? "busy (too many requests at once)" : status === 429 ? "busy (too many requests)"
      : `having problems (${status})`;
    return new ProduceError(`ElevenLabs is ${what} - trying again`, { status: 503, retry: true, after: retryAfter(retryAfterHeader) });
  }
  if (lower.includes("quota_exceeded") || lower.includes("exceeds your quota") || status === 402) {
    return new ProduceError(`${what} failed: your ElevenLabs account doesn't have enough credits left. Add credits or ` +
      "upgrade your plan at elevenlabs.io, then try again.", { status: 409 });
  }
  if ((status === 401 || status === 403) && (lower.includes("permission") || lower.includes("scope"))) {
    return new ProduceError(`${what} failed: your ElevenLabs API key is missing the '${permission}' permission. ` +
      `Edit the key at elevenlabs.io (Developers -> API keys) and enable: ${KEY_PERMISSIONS.join(", ")}.`, { status: 409 });
  }
  if (status === 401) {
    return new ProduceError(`${what} failed: ElevenLabs rejected the API key (401). Check it in Settings. ` +
      `It needs these permissions: ${KEY_PERMISSIONS.join(", ")}.`, { status: 409 });
  }
  if ((status === 404 || status === 400 || status === 422) && lower.includes("voice") && voice) {
    return new ProduceError(`${what} failed: ElevenLabs has no voice ${voice} in your account (the voice this language ` +
      "was started with). Add it back to your ElevenLabs voices, then try again.", { status: 409 });
  }
  return new ProduceError(`${what} failed (${status}): ${text.slice(0, 500)}`);
}
