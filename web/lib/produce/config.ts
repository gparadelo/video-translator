// The settings of the translation and the voice: config.default.toml's [claude] and [elevenlabs] sections.
// scripts/vt.py reads that file until the Python pipeline is removed: keep the two the same
// (test/produce-parity.test.ts checks they are).

/** config.default.toml [claude]. Also the model of the title translations (lib/translate-title.ts). */
export const CLAUDE = {
  model: "claude-opus-5-5",
  effort: "medium" as const,
  /** times Claude may rewrite the beats that don't fit before the language is voiced anyway */
  fix_rounds: 3,
  max_tokens: 16000,
  betas: ["server-side-fallback-2026-07-01"],
};

/** config.default.toml [elevenlabs] (without stt_model: transcription is the worker's until phase 4). */
export const ELEVENLABS = {
  model_id: "eleven_multilingual_v2",
  /** the clips' format: lib/pipeline (mp3.ts, the plan inputs) relies on it */
  output_format: "mp3_44100_128",
  /** all floats, as in config.default.toml: the cache key (tts.ts) writes them the way Python does */
  voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true, speed: 1.0 },
};

export const ELEVENLABS_API = "https://api.elevenlabs.io";

/** The ElevenLabs key permissions the whole app needs (vt.KEY_PERMISSIONS), named in key problems. */
export const KEY_PERMISSIONS = ["Text to Speech", "Speech to Text", "Forced Alignment"];
