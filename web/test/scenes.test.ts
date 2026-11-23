// The scene cut detection (lib/prepare/scenes.ts) against ffmpeg itself, on test videos (test/videos.mjs): hard
// cuts, still pictures brightened by 19, 20 (a score of exactly 0.2, which isn't a cut), 21 and 30 levels, a fade, a
// short dissolve, 24/25/29.97/30/60 fps at several time bases, sizes that aren't multiples of 16, and rotated phone
// videos. The frames come from ffmpeg's own decoder here (the browser's decoder gives the same pictures; test/e2e
// checks the browser end to end), with the rotation left out so this code applies it:
//   - every scaled picture must be ffmpeg's `scale=270:-2` to the bit,
//   - every frame's score must be ffmpeg's (it prints 6 decimals),
//   - the cuts must be the ones ffmpeg's `select='gt(scene,0.2)'` finds, snapped to the frame grid (test/reference.mjs).
//
// Needs ffmpeg; skipped otherwise.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALIGN, cutsFromScores, initFilter, LumaScaler, ptsTime, rotatePlane, SceneScorer, sceneSize } from "../lib/prepare/scenes";
import { frameTimes } from "./media-node";
import { media, sceneScores } from "./reference.mjs";
import { makeVideo, probe, VIDEOS } from "./videos.mjs";

const ready = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * ffmpeg's decoded luma planes, every frame, as yuv420p (the select filter gets that), one at a time to `each`: as
 * decoded (no autorotate), or with `vf` applied (with autorotate).
 */
async function eachFrame(path: string, w: number, h: number, vf: string | null, each: (y: Uint8Array, i: number) => void) {
  const p = spawn("ffmpeg", ["-v", "error", ...(vf ? [] : ["-noautorotate"]), "-i", path, "-an", ...(vf ? ["-vf", vf] : []),
    "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], { stdio: ["ignore", "pipe", "inherit"] });
  const size = w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2);
  let buf = Buffer.alloc(0), n = 0;
  for await (const chunk of p.stdout) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= size) {
      each(new Uint8Array(buf.subarray(0, w * h)), n++);
      buf = buf.subarray(size);
    }
  }
  return n;
}

const SCENE_VIDEOS = ["cuts", "steps", "ntsc", "film", "sixty", "rotated", "rotated180"] as const;

describe.skipIf(!ready)("scene cuts against ffmpeg", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vt-scenes-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("sizes as scale=270:-2", () => {
    expect(sceneSize(1080, 1920)).toEqual([270, 480]);
    expect(sceneSize(1920, 1080)).toEqual([270, 152]);
    expect(sceneSize(1080, 1350)).toEqual([270, 338]);
    expect(sceneSize(606, 1080)).toEqual([270, 482]);
    expect(sceneSize(2160, 3840)).toEqual([270, 480]);
  });

  it("the filters fit the picture and sum to one", () => {
    for (const [s, d] of [[1080, 270], [1920, 480], [2160, 270], [3840, 480], [606, 270], [200, 270], [270, 270]]) {
      for (const [one, align] of [[1 << 14, ALIGN.horizontal], [1 << 12, ALIGN.vertical], [1 << 14, 1]]) {
        const f = initFilter(s, d, one, align);
        for (let i = 0; i < d; i++) {
          let sum = 0;
          for (let j = 0; j < f.size; j++) sum += f.coeffs[i * f.size + j];
          expect(Math.abs(sum - one)).toBeLessThanOrEqual(1);
          expect(f.pos[i] >= 0 && f.pos[i] + f.size <= Math.max(s, f.size)).toBe(true);
        }
      }
    }
  });

  for (const name of SCENE_VIDEOS) {
    it(`${name}: scaled pictures, scores and cuts as ffmpeg's`, async () => {
      const path = makeVideo(dir, name);
      const vs = probe(path).streams.find((s: { codec_type: string }) => s.codec_type === "video");
      const W = vs.width, H = vs.height;
      const rotation = ((VIDEOS[name] as { rotation?: number }).rotation ?? 0) as 0 | 90 | 180 | 270;
      const shownW = rotation % 180 ? H : W, shownH = rotation % 180 ? W : H;
      const [sw, sh] = sceneSize(shownW, shownH);
      const scaledByFfmpeg: Uint8Array[] = [];
      await eachFrame(path, sw, sh, "scale=270:-2", (y) => void scaledByFfmpeg.push(y));

      const scaler = new LumaScaler(shownW, shownH, sw, sh);
      const scorer = new SceneScorer();
      const times = await frameTimes(path);
      const ours: { t: number; score: number }[] = [];
      let differentPictures = 0;
      const decoded = await eachFrame(path, W, H, null, (f, i) => {
        const r = rotatePlane(f, W, W, H, rotation);
        const out = new Uint8Array(sw * sh);
        scaler.scale(r.data, r.stride, out);
        if (Buffer.compare(Buffer.from(out), Buffer.from(scaledByFfmpeg[i] ?? [])) !== 0) differentPictures++;
        ours.push({ t: times[i], score: scorer.push(out) });
      });
      expect(decoded).toBe(scaledByFfmpeg.length);
      expect(times.length).toBe(decoded);
      expect(differentPictures).toBe(0);

      const theirs = sceneScores(path) as [string, string][];
      expect(theirs.length).toBe(ours.length);
      ours.forEach((o, i) => {
        expect(o.score.toFixed(6)).toBe(theirs[i][1]);
        expect(ptsTime(o.t)).toBe(Number(theirs[i][0]));
      });

      const ff = media(path);
      const cuts = cutsFromScores(ours, 0.2, ff.dur, ff.fps);
      expect(cuts).toEqual(ff.cuts);
      const expected = (VIDEOS[name] as { cuts: number[] | null }).cuts;
      if (expected) expect(cuts.map((c) => Math.round(c * 100) / 100)).toEqual(expected);
      if (name === "steps") { // 19 levels isn't a cut, nor is the fade; 21 and 30 are, up and down, and back from black
        expect(cuts.filter((c) => (c > 0.9 && c < 2.1) || (c > 5.6 && c < 6.9))).toEqual([]);
        expect([4, 5, 7].every((c) => cuts.includes(c))).toBe(true);
      }
    });
  }
});
