// Which ffmpeg the tests run against. Most checks compare the app with ffmpeg run here and now, but some results
// also depend on ffmpeg's own version: the scene scores (swscale's scaling, ported from ffmpeg 9), the encoded test
// videos and fake TTS clips (x264, ffmpeg's AAC encoder, libmp3lame) whose measures and lengths the frozen
// references in test/fixtures/ were made from. Those were made and checked with ffmpeg 9.0. Another version can make
// some checks fail although the app didn't change: this says so up front instead of leaving it to guesswork.
//
// Used as vitest's globalSetup and by test/e2e/run.mjs. Without ffmpeg the run stops (most of what the tests check
// would be skipped and the run would still look green), unless VT_SKIP_FFMPEG=1 asks for the plain unit tests only.

import { spawnSync } from "node:child_process";

/** The ffmpeg major.minor the references were made and checked with. */
export const FFMPEG_CHECKED = "9.0";

/** "9.0.2" etc., or null when ffmpeg or ffprobe isn't on the PATH. */
export function ffmpegVersion() {
  const versions = ["ffmpeg", "ffprobe"].map((cmd) => {
    const r = spawnSync(cmd, ["-version"], { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    return /version n?(\S+)/.exec(r.stdout)?.[1] ?? "unknown";
  });
  return versions.includes(null) ? null : versions[0];
}

/** Stops without ffmpeg (unless VT_SKIP_FFMPEG=1), warns when its version isn't the one the references were made with. */
export function checkFfmpeg({ allowSkip = true } = {}) {
  const v = ffmpegVersion();
  if (!v) {
    if (allowSkip && process.env.VT_SKIP_FFMPEG === "1") {
      console.warn("\nVT_SKIP_FFMPEG=1: ffmpeg/ffprobe not used, every check against ffmpeg and the frozen references is SKIPPED.\n");
      return null;
    }
    throw new Error("ffmpeg and ffprobe must be on the PATH for the tests (brew install ffmpeg). " +
      (allowSkip ? "To run only the plain unit tests, set VT_SKIP_FFMPEG=1." : ""));
  }
  if (!v.startsWith(`${FFMPEG_CHECKED}.`) && v !== FFMPEG_CHECKED) {
    console.warn(`\n*** ffmpeg ${v}: the references were made and checked with ffmpeg ${FFMPEG_CHECKED}. A failing scene score, ` +
      "cut, loudness or clip length may be this ffmpeg's doing rather than the app's (see \"Tests\" in web/README.md). ***\n");
  }
  return v;
}

/** vitest globalSetup */
export default function setup() {
  checkFfmpeg();
}
