// Test videos made with ffmpeg, for the checks of the browser's analysis (scene cuts, frame rate, length,
// loudness, the extracted voiceover) and the file checks. Plain JavaScript, shared by the vitest tests and
// test/e2e/run.mjs. Each video is made once per folder.
//
//   makeVideo(dir, name) -> path      VIDEOS[name] says what it is

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** "Words" of a fake voiceover: [start, end] seconds of each, a tone burst per word (like test/mocks.mjs's voices). */
export const SPOKEN = [
  ["Hello", 0.62, 0.98], ["and", 1.04, 1.22], ["welcome", 1.3, 1.82], ["to", 1.9, 2.02], ["Nano", 2.1, 2.42],
  ["Leaf", 2.46, 2.8], ["lights.", 2.86, 3.3], ["They", 3.9, 4.12], ["change", 4.2, 4.62], ["colour", 4.7, 5.1],
  ["with", 5.18, 5.36], ["your", 5.42, 5.6], ["music.", 5.66, 6.2], ["Try", 7.4, 7.62], ["them", 7.68, 7.9],
  ["today!", 7.96, 8.5],
];

/** The tone bursts of SPOKEN as an aevalsrc expression (0.3 full scale, 220 Hz plus a little 2nd harmonic). */
function voiceExpr(words = SPOKEN) {
  const env = words.map(([, a, b]) => `between(t,${a},${b})`).join("+");
  return `0.3*(${env})*(sin(2*PI*220*t)+0.3*sin(2*PI*440*t))/1.3`;
}

const lavfi = (spec) => ["-f", "lavfi", "-i", spec];

/**
 * The "steps" picture: still, brightened by [from, to, levels] in places; from 5.5 s it fades to black over a
 * second (a fade: no cut), and at 7 s it's back at once (a cut).
 */
const STEPS = [[1, 2, 19], [2.5, 3.5, 20], [4, 4.5, 21], [5, 5.5, 30]];
function stepsGraph() {
  const bounds = [0, ...STEPS.flatMap(([a, b]) => [a, b]), 7, 8];
  const parts = bounds.slice(1).map((end, i) => {
    const step = STEPS.find(([a]) => a === bounds[i]);
    const extra = step ? `,lutyuv=y=val+${step[2]}` : end === 7 ? ",fade=t=out:st=0.4:d=1" : "";
    return `[s${i}]trim=${bounds[i]}:${end},setpts=PTS-STARTPTS${extra}[p${i}]`;
  });
  return `[0]lutyuv=y=val*0.6+40,split=${parts.length}${parts.map((_, i) => `[s${i}]`).join("")};${parts.join(";")};` +
    `${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=1:a=0[v]`;
}
const x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];

/**
 * name -> how it's made. `cuts` are the hard cuts the picture has (seconds); `fps` its frame rate.
 * Durations are short so the tests stay quick.
 */
export const VIDEOS = {
  // hard cuts between very different pictures, 30 fps, portrait 1080x1920, stereo 48 kHz voice; the frame number is
  // drawn across the top ninth as test/vt_fixture.py's videos have it, so renders of it can be checked frame by frame
  cuts: {
    fps: 30, cuts: [2.5, 4.2, 6.5], dur: 9,
    args: () => [
      ...lavfi("testsrc2=s=1080x1920:r=30:d=2.5"), ...lavfi("smptebars=s=1080x1920:r=30:d=1.7"),
      ...lavfi("mandelbrot=s=1080x1920:r=30:end_pts=1000"), ...lavfi("rgbtestsrc=s=1080x1920:r=30:d=2.5"),
      ...lavfi(`aevalsrc='${voiceExpr()}|${voiceExpr()}':s=48000:d=9`),
      ...lavfi(`color=black:s=1080x213:r=30:d=9,format=gray,geq=lum='if(mod(floor(N/pow(2\\,floor(X*16/1080)))\\,2)\\,255\\,0)'`),
      "-filter_complex", "[2]trim=duration=2.3,setpts=PTS-STARTPTS[m];[0][1][m][3]concat=n=4:v=1:a=0[c];[5]format=yuv420p[b];[c][b]overlay=0:0[v]",
      "-map", "[v]", "-map", "4", ...x264, "-c:a", "aac", "-b:a", "160k", "-shortest",
    ],
  },
  // near the threshold (0.2): a still picture (levels 40-181) whose brightness steps by 19, 20 (exactly 0.2: not a
  // cut), 21 and 30 levels, a one-second fade (no cut), then back from black; 25 fps at 1/90000, mono 44.1 kHz
  steps: {
    // ffmpeg (and vt.py) find 2.52, 3.52, 4, 4.52, 5, 5.52 and 7: after encoding, the 20-level step lands a
    // little above 0.2, and the steps back down score highest on the frame after
    fps: 25, cuts: null, dur: 8,
    args: () => [
      ...lavfi("smptebars=s=720x1280:r=25:d=8"),
      ...lavfi(`aevalsrc='${voiceExpr()}':s=44100:d=8`),
      "-filter_complex", stepsGraph(), "-map", "[v]", "-map", "1",
      ...x264, "-video_track_timescale", "90000", "-c:a", "aac", "-b:a", "128k",
    ],
  },
  // 29.97 fps at a 1/600 time base (uneven ticks per frame, like phones), cuts, 1080x1350
  ntsc: {
    fps: 30000 / 1001, cuts: [1.5, 3.2], dur: 5,
    args: () => [
      ...lavfi("testsrc=s=1080x1350:r=30000/1001:d=1.5"), ...lavfi("rgbtestsrc=s=1080x1350:r=30000/1001:d=1.7"),
      ...lavfi("smptehdbars=s=1080x1350:r=30000/1001:d=1.8"),
      ...lavfi(`aevalsrc='${voiceExpr()}':s=48000:d=5`),
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3",
      ...x264, "-video_track_timescale", "600", "-c:a", "aac", "-b:a", "128k", "-shortest",
    ],
  },
  // 24 fps and 60 fps, 606x1080 (not a multiple of 16)
  film: {
    fps: 24, cuts: [1.25], dur: 3,
    args: () => [
      ...lavfi("testsrc2=s=606x1080:r=24:d=1.25"), ...lavfi("smptebars=s=606x1080:r=24:d=1.75"),
      ...lavfi(`aevalsrc='${voiceExpr()}':s=48000:d=3`),
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2", ...x264, "-c:a", "aac", "-shortest",
    ],
  },
  sixty: {
    fps: 60, cuts: [1.1], dur: 2.5,
    args: () => [
      ...lavfi("testsrc2=s=720x1280:r=60:d=1.1"), ...lavfi("rgbtestsrc=s=720x1280:r=60:d=1.4"),
      ...lavfi(`aevalsrc='${voiceExpr()}':s=48000:d=2.5`),
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2", ...x264, "-c:a", "aac", "-shortest",
    ],
  },
  // a phone video held upright: landscape 1920x1080 frames shown rotated by 90 degrees
  rotated: {
    fps: 30, cuts: [1.5], dur: 3, rotation: 90,
    args: () => [
      ...lavfi("testsrc2=s=1920x1080:r=30:d=1.5"), ...lavfi("smptebars=s=1920x1080:r=30:d=1.5"),
      ...lavfi(`aevalsrc='${voiceExpr()}':s=48000:d=3`),
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2", ...x264, "-c:a", "aac", "-shortest",
    ],
    after: (tmp, out) => ["-display_rotation", "-90", "-i", tmp, "-c", "copy", out],
  },
  rotated180: {
    fps: 30, cuts: [1.5], dur: 3, rotation: 180,
    args: () => VIDEOS.rotated.args(),
    after: (tmp, out) => ["-display_rotation", "180", "-i", tmp, "-c", "copy", out],
  },
  // ---- the file checks' cases
  // HDR: tagged HLG (iPhone default) and PQ, BT.2020 primaries
  hlg: {
    fps: 30, cuts: null, dur: 2,
    args: () => [...lavfi("testsrc2=s=720x1280:r=30:d=2"), ...lavfi("sine=f=220:d=2"), 
      "-vf", "setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc", ...x264, "-c:a", "aac"],
  },
  pq: {
    fps: 30, cuts: null, dur: 2,
    args: () => [...lavfi("testsrc2=s=720x1280:r=30:d=2"), ...lavfi("sine=f=220:d=2"), 
      "-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc", ...x264, "-c:a", "aac"],
  },
  // variable frame rate: frames 1/30 s apart, then 1/15, then 1/60 (a screen recording or a phone in low light)
  vfr: {
    fps: null, cuts: null, dur: 3,
    args: () => [...lavfi("testsrc2=s=720x1280:r=60:d=3"), ...lavfi("sine=f=220:d=3"),
      "-vf", "select='if(lt(t,1),not(mod(n,2)),if(lt(t,2),not(mod(n,4)),1))'", "-fps_mode", "vfr", ...x264, "-c:a", "aac"],
  },
  silent: { // no sound track
    fps: 30, cuts: null, dur: 2,
    args: () => [...lavfi("testsrc2=s=720x1280:r=30:d=2"), ...x264],
  },
  mpeg4: { // a picture codec browsers can't decode (MPEG-4 Part 2)
    fps: 30, cuts: null, dur: 2,
    args: () => [...lavfi("testsrc2=s=720x1280:r=30:d=2"), ...lavfi("sine=f=220:d=2"), "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac"],
  },
  ac3: { // a sound codec Chrome can't decode
    fps: 30, cuts: null, dur: 2,
    args: () => [...lavfi("testsrc2=s=720x1280:r=30:d=2"), ...lavfi("sine=f=220:d=2"), ...x264, "-c:a", "ac3"],
  },
  tiny: { // too short to have a voiceover
    fps: 30, cuts: null, dur: 0.5,
    args: () => [...lavfi("testsrc2=s=720x1280:r=30:d=0.5"), ...lavfi("sine=f=220:d=0.5"), ...x264, "-c:a", "aac"],
  },
};

/** The video `name` in `dir` (made with ffmpeg the first time). */
export function makeVideo(dir, name) {
  const v = VIDEOS[name];
  const out = join(dir, `${name}.mp4`);
  if (existsSync(out)) return out;
  const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  if (v.after) {
    const tmp = join(dir, `${name}.tmp.mp4`);
    ff([...v.args(), tmp]);
    ff([...v.after(tmp, out)]);
  } else {
    ff([...v.args(), out]);
  }
  return out;
}

/** ffprobe's view of a file (streams and format), as vt.probe has it. */
export function probe(path) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
}
