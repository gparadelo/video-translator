// The tuning numbers of the timing plan and the voice track. FIT is config.default.toml's [fit] (scripts/vt.py
// still reads that file until the Python pipeline is removed: keep the two the same). A language's plan inputs
// carry the numbers they were made with (inputs.json "fit"), so a plan is always rebuilt with those.

export type Fit = {
  /** clips may be slowed down to this speed... */
  video_speed_min: number;
  /** ...or sped up to this one */
  video_speed_max: number;
  /** a clip may be trimmed (its tail cut off) down to this fraction of its length */
  trim_keep_min: number;
  /** the voice may be slowed down this much after it was generated... */
  audio_tempo_min: number;
  /** ...or sped up this much */
  audio_tempo_max: number;
  /** seconds a cut may land away from its word */
  sync_tolerance: number;
  /** shortest pause between beats (seconds) */
  pause_min: number;
  /** pauses between beats may grow by this much (seconds) */
  pause_max_extra: number;
};

export const FIT: Fit = {
  video_speed_min: 0.9,
  video_speed_max: 1.1,
  trim_keep_min: 0.4,
  audio_tempo_min: 0.96,
  audio_tempo_max: 1.07,
  sync_tolerance: 0.25,
  pause_min: 0.1,
  pause_max_extra: 0.4,
};

export const FIT_KEYS = Object.keys(FIT) as (keyof Fit)[];

/** The voice track: 16-bit PCM at this rate, stereo (vt.SR, vt.build_voice_track). */
export const SAMPLE_RATE = 44100;
export const CHANNELS = 2;

/** Each beat's clip starts this long before its first word and ends this long after its last (vt.beat_timing). */
export const CLIP_LEAD = 0.04;
export const CLIP_TAIL = 0.1;

/** The limiter at the end of the voice track (ffmpeg alimiter=limit=0.95:level=0 in vt.voice_filter). */
export const LIMITER = { limit: 0.95, attackMs: 5, releaseMs: 50 };
