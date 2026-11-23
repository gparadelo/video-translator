// The settings of the translation and the voice. They are the old Python pipeline's (test/produce-parity.test.ts
// checks they still are): the voice settings are part of every clip's cache key, so changing one voices every
// language again instead of reusing the clips in storage.

/** Claude. Also the model of the title translations (lib/translate-title.ts). */
export const CLAUDE = {
  model: "claude-opus-5-5",
  effort: "medium" as const,
  /** times Claude may rewrite the beats that don't fit before the language is voiced anyway */
  fix_rounds: 3,
  max_tokens: 16000,
  betas: ["server-side-fallback-2026-07-01"],
};

/** The speech-to-text model that transcribes the voiceover (lib/prepare). */
export const STT_MODEL = "scribe_v2";

/** ElevenLabs: the voice's model, format and settings. */
export const ELEVENLABS = {
  model_id: "eleven_multilingual_v2",
  /** the clips' format: lib/pipeline (mp3.ts, the plan inputs) relies on it */
  output_format: "mp3_44100_128",
  /** all floats: the cache key (tts.ts) writes them the way Python did */
  voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true, speed: 1.0 },
};

export const ELEVENLABS_API = "https://api.elevenlabs.io";

/** The ElevenLabs key permissions the whole app needs, named in key problems. */
export const KEY_PERMISSIONS = ["Text to Speech", "Speech to Text", "Forced Alignment"];
