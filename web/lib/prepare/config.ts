// The analysis settings.

export const ANALYZE = {
  /** scene_threshold: cut detection sensitivity (a frame scoring above it is a cut) */
  scene_threshold: 0.2,
  /** beat_pause: a silence this long (seconds) mid-sentence starts a new beat in a transcript */
  beat_pause: 1.0,
  /** fix_names: after transcribing, Claude fixes misspelled names */
  fix_names: true,
};

/** Limits of what the app takes (the file checks, lib/prepare/checks.ts). */
export const LIMITS = {
  /** the voiceover must be at least this long (seconds) */
  minSeconds: 1,
  /** short-form videos: the analysis, the voice and the render are all made for this length or less */
  maxSeconds: 10 * 60,
  /** the shown picture's longer side, in pixels (8K) */
  maxSide: 8192,
  minSide: 64,
  /** the highest frame rate (frames per second) */
  maxFps: 120,
};
