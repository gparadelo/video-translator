// Output sizes and bitrates. Same rules as scripts/vt.py (render_size, scaled_bitrate).

import { pyFixed } from "./numbers";

export type QualityId = "original" | "1080p" | "720p";

export type Quality = {
  id: QualityId;
  width: number;
  height: number;
  /** Bits per second for HEVC; H.264 gets AVC_FACTOR times this. */
  bitrate: number;
  /** Bigger outputs favour quality; 720p favours speed. Not shown to people. */
  latencyMode: "quality" | "realtime";
};

/** The bitrate in config.default.toml ([render] video_bitrate): for 4K HEVC, scaled down for smaller sizes. */
export const BASE_BITRATE = 20_000_000;
/** H.264 needs about half as many bits again as HEVC for the same picture. */
export const AVC_FACTOR = 1.5;
/** The preview only has to show whether the cuts land on their words. */
export const PREVIEW_FACTOR = 0.6;
export const AUDIO_BITRATE = 192_000;

/** vt.render_size: the source's own size, rounded down to even numbers for the encoder. */
export function renderSize(w: number, h: number): [number, number] {
  return [Math.max(2, w - (w % 2)), Math.max(2, h - (h % 2))];
}

/** vt.scaled_bitrate: `bitrate` is for 3840x2160; smaller videos get less, a bit more than in proportion. */
export function scaledBitrate(bitrate: number, w: number, h: number): number {
  const bps = bitrate * ((w * h) / (3840 * 2160)) ** 0.75;
  return Number(pyFixed(Math.max(bps, 1e6) / 1e3, 0)) * 1000; // Python formats it as "<n>k"
}

/** The size whose short side is `short` (e.g. 720 for 720p), keeping the shape, in even numbers. */
export function sizeForShortSide(w: number, h: number, short: number): [number, number] {
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  return w <= h ? [even(short), even((h * short) / w)] : [even((w * short) / h), even(short)];
}

const LABELS: Record<QualityId, string> = { original: "Original", "1080p": "1080p", "720p": "720p" };
export const qualityLabel = (q: Quality) => `${LABELS[q.id]} (${q.width}×${q.height})`;

/**
 * The choices for a source of this (displayed) size: the original, and 1080p / 720p only when they are
 * smaller than it. Never bigger than the source.
 */
export function qualityOptions(srcW: number, srcH: number): Quality[] {
  const [w, h] = renderSize(srcW, srcH);
  const short = Math.min(w, h);
  const out: Quality[] = [{ id: "original", width: w, height: h, bitrate: scaledBitrate(BASE_BITRATE, w, h), latencyMode: "quality" }];
  for (const [id, side] of [["1080p", 1080], ["720p", 720]] as const) {
    if (short <= side) continue;
    const [qw, qh] = sizeForShortSide(w, h, side);
    out.push({ id, width: qw, height: qh, bitrate: scaledBitrate(BASE_BITRATE, qw, qh), latencyMode: id === "720p" ? "realtime" : "quality" });
  }
  return out;
}

/** The preview: 720p (or the source size, if smaller), H.264 so every browser plays it. */
export function previewQuality(srcW: number, srcH: number): Quality {
  const [w, h] = renderSize(srcW, srcH);
  const [pw, ph] = Math.min(w, h) > 720 ? sizeForShortSide(w, h, 720) : [w, h];
  return { id: "720p", width: pw, height: ph, bitrate: Math.round(scaledBitrate(BASE_BITRATE, pw, ph) * PREVIEW_FACTOR), latencyMode: "realtime" };
}

/** Estimated render times (seconds) per option -> the one to preselect: the best that takes at most `budget`. */
export function pickQuality(options: Quality[], estimates: Partial<Record<QualityId, number>>, budget = 180): QualityId {
  const known = options.filter((o) => estimates[o.id] != null);
  if (!known.length) return options[0].id;
  const fits = known.find((o) => estimates[o.id]! <= budget);
  if (fits) return fits.id;
  return known.reduce((a, b) => (estimates[b.id]! < estimates[a.id]! ? b : a)).id;
}

/** "about 2 min", "under a minute". */
export function durationText(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const min = Math.round(seconds / 60);
  return `about ${min} min`;
}
