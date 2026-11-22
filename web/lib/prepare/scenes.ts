// Scene cuts as scripts/vt.py finds them (vt.detect_cuts):
//
//   ffmpeg -i <video> -an -vf "scale=270:-2,select='gt(scene,<threshold>)',metadata=print" -f null -
//
// ported from ffmpeg itself (version 9; libswscale/utils.c initFilter, hscale8to15 and yuv2planeX for 8-bit
// planar YUV, libavfilter/f_select.c get_scene_score, libavfilter/scale_eval.c for "-2"):
//
//   1. each frame's luma plane (8 bits, rotation applied, as ffmpeg's autorotate does before the filters) is
//      scaled to 270 pixels wide with swscale's default bicubic filter (B = 0, C = 0.6), in its fixed-point
//      arithmetic: a horizontal pass to 15-bit intermediates, then a vertical one with rounding;
//   2. the score of a frame is the mean absolute difference (MAFD) of its scaled luma against the previous
//      frame's, in levels; a frame scores min(MAFD, |MAFD - previous MAFD|) / 100, clipped to [0, 1];
//   3. a frame whose score is above the threshold is a cut, at its time rounded to the frame grid.
//
// Pure (no DOM); the browser feeds it decoded frames (lib/prepare/media.ts). test/scenes.test.ts checks the
// scaled pictures and the scores against the ffmpeg on this machine, frame by frame.
//
// The only freedom ffmpeg has here is its filter "alignment", which depends on the CPU it was built for: SIMD
// builds (x86, arm64/NEON) pad the horizontal filters to 4 taps and the vertical ones to 2, keeping a few tiny
// coefficients a plain C build drops. ALIGN is the SIMD builds' (what people run). Within one alignment the
// result is ffmpeg's to the bit, except x86's vertical pass without accurate_rnd, which rounds slightly
// differently (at most 2 levels per pixel; a score moves by far less than 0.001).

export const SCENE_WIDTH = 270;
export const ALIGN = { horizontal: 4, vertical: 2 };

/** av_rescale(a, b, c): a * b / c rounded to the nearest, halves away from zero (all positive here). */
const rescale = (a: number, b: number, c: number) => Math.floor((a * b + Math.floor(c / 2)) / c);

/** The size `scale=270:-2` gives a picture of w x h (libavfilter/scale_eval.c). */
export function sceneSize(w: number, h: number): [number, number] {
  return [SCENE_WIDTH, Math.max(2, rescale(SCENE_WIDTH, h, w * 2) * 2)];
}

/** av_log2 of a non-negative integer (av_log2(0) = 0). */
const log2 = (x: number) => (x > 0 ? Math.floor(Math.log2(x)) : 0);

/** C's integer division of int64 values (truncates toward zero): BigInt division does the same. */
const B = BigInt;

/**
 * initFilter for SWS_BICUBIC with default parameters and no extra src/dst filters: per output pixel, the
 * first source pixel (pos) and filterSize 14-bit (horizontal, one = 1 << 14) or 12-bit (vertical, one = 1 << 12)
 * coefficients.
 */
export function initFilter(srcW: number, dstW: number, one: number, filterAlign: number): { pos: Int32Array; coeffs: Int16Array; size: number } {
  const xInc = Math.floor((srcW * 65536 + (dstW >> 1)) / dstW); // lumXInc / lumYInc
  const fone = B(1) << B(54 - Math.min(log2(Math.trunc(srcW / dstW)), 8));
  const pos = new Int32Array(dstW);
  let filterSize: number;
  let filter: bigint[];
  const srcPos = 128, dstPos = 128; // get_local_pos(c, 0, 0, dir) for luma

  if (Math.abs(xInc - 0x10000) < 10 && srcPos === dstPos) { // unscaled
    filterSize = 1;
    filter = new Array(dstW).fill(fone);
    for (let i = 0; i < dstW; i++) pos[i] = i;
  } else {
    const sizeFactor = 4; // bicubic
    filterSize = xInc <= 1 << 16 ? 1 + sizeFactor : 1 + Math.trunc((sizeFactor * srcW + dstW - 1) / dstW);
    filterSize = Math.max(Math.min(filterSize, srcW - 2), 1);
    filter = new Array(dstW * filterSize).fill(B(0));
    let xDstInSrc = ((B(dstPos) * B(xInc)) >> B(7)) - ((B(srcPos) * B(0x10000)) >> B(7));
    const Bc = B(0); // param[0] default: B = 0
    const Cc = B(Math.trunc(0.6 * (1 << 24))); // param[1] default 0.6, as int64
    const S24 = B(1) << B(24), S30 = B(1) << B(30);
    for (let i = 0; i < dstW; i++) {
      let xx = Number((xDstInSrc - B(filterSize - 2) * (B(1) << B(16))) / (B(1) << B(17)));
      pos[i] = xx;
      for (let j = 0; j < filterSize; j++) {
        const dist = B(xx) * (B(1) << B(17)) - xDstInSrc;
        let d = (dist < B(0) ? -dist : dist) << B(13);
        if (xInc > 1 << 16) d = (d * B(dstW)) / B(srcW);
        let coeff: bigint;
        if (d >= B(1) << B(31)) {
          coeff = B(0);
        } else {
          const dd = (d * d) >> B(30);
          const ddd = (dd * d) >> B(30);
          if (d < B(1) << B(30)) {
            coeff = (B(12) * S24 - B(9) * Bc - B(6) * Cc) * ddd + (-B(18) * S24 + B(12) * Bc + B(6) * Cc) * dd + (B(6) * S24 - B(2) * Bc) * S30;
          } else {
            coeff = (-Bc - B(6) * Cc) * ddd + (B(6) * Bc + B(30) * Cc) * dd + (-B(12) * Bc - B(48) * Cc) * d + (B(8) * Bc + B(24) * Cc) * S30;
          }
        }
        coeff /= (B(1) << B(54)) / fone;
        filter[i * filterSize + j] = coeff;
        xx++;
      }
      xDstInSrc += B(2) * B(xInc);
    }
  }

  // no src/dst filters: filter2 = filter, filterPos unchanged ((filterSize-1)/2 - (filter2Size-1)/2 = 0)
  const filter2Size = filterSize;
  const filter2 = filter;
  const abs = (x: bigint) => (x < B(0) ? -x : x);
  const cutOffLimit = 0.002 * Number(fone); // SWS_MAX_REDUCE_CUTOFF * fone, a double in C
  let minFilterSize = 0;
  for (let i = dstW - 1; i >= 0; i--) {
    let min = filter2Size;
    let cutOff = B(0);
    for (let j = 0; j < filter2Size; j++) { // drop near-zero coefficients on the left
      cutOff += abs(filter2[i * filter2Size]);
      if (Number(cutOff) > cutOffLimit) break;
      if (i < dstW - 1 && pos[i] >= pos[i + 1]) break;
      let k;
      for (k = 1; k < filter2Size; k++) filter2[i * filter2Size + k - 1] = filter2[i * filter2Size + k];
      filter2[i * filter2Size + k - 1] = B(0);
      pos[i]++;
    }
    cutOff = B(0);
    for (let j = filter2Size - 1; j > 0; j--) { // count near zeros on the right
      cutOff += abs(filter2[i * filter2Size + j]);
      if (Number(cutOff) > cutOffLimit) break;
      min--;
    }
    if (min > minFilterSize) minFilterSize = min;
  }
  // SIMD builds: special case for unscaled vertical filtering
  if (minFilterSize === 1 && filterAlign === 2) filterAlign = 1;
  const size = (minFilterSize + (filterAlign - 1)) & ~(filterAlign - 1);
  const f: bigint[] = new Array(dstW * size).fill(B(0));
  for (let i = 0; i < dstW; i++) {
    for (let j = 0; j < size; j++) f[i * size + j] = j >= filter2Size ? B(0) : filter2[i * filter2Size + j];
  }

  // fix borders
  for (let i = 0; i < dstW; i++) {
    if (pos[i] < 0) {
      for (let j = 1; j < size; j++) {
        const left = Math.max(j + pos[i], 0);
        f[i * size + left] += f[i * size + j];
        f[i * size + j] = B(0);
      }
      pos[i] = 0;
    }
    if (pos[i] + size > srcW) {
      const shift = pos[i] + Math.min(size - srcW, 0);
      let acc = B(0);
      for (let j = size - 1; j >= 0; j--) {
        if (pos[i] + j >= srcW) {
          acc += f[i * size + j];
          f[i * size + j] = B(0);
        }
      }
      for (let j = size - 1; j >= 0; j--) f[i * size + j] = j < shift ? B(0) : f[i * size + j - shift];
      pos[i] -= shift;
      f[i * size + srcW - 1 - pos[i]] += acc;
    }
  }

  // normalize & store
  const coeffs = new Int16Array(dstW * size);
  const oneB = B(one);
  for (let i = 0; i < dstW; i++) {
    let sum = B(0);
    for (let j = 0; j < size; j++) sum += f[i * size + j];
    sum = (sum + oneB / B(2)) / oneB;
    if (!sum) sum = B(1);
    let error = B(0);
    for (let j = 0; j < size; j++) {
      const v = f[i * size + j] + error;
      const intV = (v >= B(0) ? v + (sum >> B(1)) : v - (sum >> B(1))) / sum; // ROUNDED_DIV
      coeffs[i * size + j] = Number(intV);
      error = v - intV * sum;
    }
  }
  return { pos, coeffs, size };
}

/** Scales 8-bit luma planes from srcW x srcH to dstW x dstH as swscale does (bicubic). Reusable for many frames. */
export class LumaScaler {
  readonly h: ReturnType<typeof initFilter>;
  readonly v: ReturnType<typeof initFilter>;
  private rows: Int16Array;
  constructor(readonly srcW: number, readonly srcH: number, readonly dstW: number, readonly dstH: number, align = ALIGN) {
    this.h = initFilter(srcW, dstW, 1 << 14, align.horizontal);
    this.v = initFilter(srcH, dstH, 1 << 12, align.vertical);
    this.rows = new Int16Array(srcH * dstW);
  }

  /** `src`: the luma plane, `stride` bytes per row. Writes dstW x dstH bytes into `out`. */
  scale(src: Uint8Array, stride: number, out: Uint8Array) {
    const { srcW, srcH, dstW, dstH, rows } = this;
    if (srcW === dstW && srcH === dstH) { // swscale's unscaled copy
      for (let y = 0; y < dstH; y++) out.set(src.subarray(y * stride, y * stride + dstW), y * dstW);
      return;
    }
    const { pos: hp, coeffs: hc, size: hs } = this.h;
    for (let y = 0; y < srcH; y++) { // hScale8To15_c on every source row
      const row = y * stride, o = y * dstW;
      for (let i = 0; i < dstW; i++) {
        const p = row + hp[i], c = i * hs;
        let val = 0;
        for (let j = 0; j < hs; j++) val += src[p + j] * hc[c + j];
        const s = val >> 7;
        rows[o + i] = s < 32767 ? s : 32767;
      }
    }
    const { pos: vp, coeffs: vc, size: vs } = this.v;
    for (let y = 0; y < dstH; y++) {
      const first = vp[y], c = y * vs, o = y * dstW;
      if (vs === 1) { // yuv2plane1_8_c, dither 64
        for (let i = 0; i < dstW; i++) {
          const v = (rows[first * dstW + i] + 64) >> 7;
          out[o + i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        continue;
      }
      for (let i = 0; i < dstW; i++) { // yuv2planeX_8_c, dither 64 << 12
        let val = 262144;
        for (let j = 0; j < vs; j++) val += rows[(first + j) * dstW + i] * vc[c + j];
        const v = val >> 19;
        out[o + i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
}

/** Rotates a w x h plane clockwise by `rotation` degrees (ffmpeg's autorotate: transpose=clock, hflip+vflip, transpose=cclock). */
export function rotatePlane(src: Uint8Array, stride: number, w: number, h: number, rotation: 0 | 90 | 180 | 270): { data: Uint8Array; w: number; h: number; stride: number } {
  if (rotation === 0) return { data: src, w, h, stride };
  if (rotation === 180) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = (h - 1 - y) * stride;
      for (let x = 0; x < w; x++) out[y * w + x] = src[r + w - 1 - x];
    }
    return { data: out, w, h, stride: w };
  }
  const out = new Uint8Array(w * h); // h wide, w high
  if (rotation === 90) { // clockwise: out(x, y) = in(y, h - 1 - x)
    for (let y = 0; y < w; y++) for (let x = 0; x < h; x++) out[y * h + x] = src[(h - 1 - x) * stride + y];
  } else { // counter-clockwise: out(x, y) = in(w - 1 - y, x)
    for (let y = 0; y < w; y++) for (let x = 0; x < h; x++) out[y * h + x] = src[x * stride + (w - 1 - y)];
  }
  return { data: out, w: h, h: w, stride: h };
}

/** f_select.c get_scene_score over a sequence of scaled luma pictures (8 bits). */
export class SceneScorer {
  private prev: Uint8Array | null = null;
  private prevMafd = 0;
  /** The score of this picture against the previous one (0 for the first). Keeps `pic` (don't reuse its buffer). */
  push(pic: Uint8Array): number {
    let score = 0;
    const prev = this.prev;
    if (prev && prev.length === pic.length) {
      let sad = 0;
      for (let i = 0; i < pic.length; i++) {
        const d = pic[i] - prev[i];
        sad += d < 0 ? -d : d;
      }
      const mafd = sad / pic.length;
      const diff = Math.abs(mafd - this.prevMafd);
      // av_clipf works in single precision: the score is a float (and the threshold is compared with that)
      score = Math.min(Math.max(Math.fround(Math.min(mafd, diff) / 100), 0), 1);
      this.prevMafd = mafd;
    }
    this.prev = pic;
    return score;
  }
}

/** Python's round(x) (half to even). */
function pyRound(x: number) {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

/**
 * vt.detect_cuts from the frames' times (seconds from the start of the file, as ffmpeg prints pts_time) and
 * scores: the frames above the threshold, each time rounded to the frame grid, without repeats, sorted, and not
 * within 0.05 s of either end.
 */
export function cutsFromScores(frames: { t: number; score: number }[], threshold: number, dur: number, fps: number): number[] {
  const ts = new Set<number>();
  for (const f of frames) if (f.score > threshold) ts.add(pyRound(ptsTime(f.t) * fps) / fps);
  return [...ts].sort((a, b) => a - b).filter((t) => 0.05 < t && t < dur - 0.05);
}

/**
 * The time as metadata=print writes it (av_ts_make_time_string2: "%.6f" for times from 1 s, more decimals below,
 * trailing zeros dropped) and vt.py reads it back with float().
 */
export function ptsTime(t: number): number {
  if (t === 0) return 0;
  const lg = Math.floor(Math.log10(Math.abs(t)));
  const precision = lg < 0 ? -lg + 5 : 6;
  return Number(t.toFixed(precision));
}
