import { describe, expect, it } from "vitest";
import { pickQuality, previewQuality, qualityOptions, renderSize, scaledBitrate, sizeForShortSide } from "./quality";

describe("same numbers as scripts/vt.py", () => {
  // expected values printed by vt.render_size / vt.scaled_bitrate("20M", ...)
  it.each([
    [2160, 3840, 2160, 3840, 20_000_000],
    [1080, 1920, 1080, 1920, 7_071_000],
    [720, 1280, 720, 1280, 3_849_000],
    [1280, 720, 1280, 720, 3_849_000],
    [640, 360, 640, 360, 1_361_000],
    [1440, 1800, 1440, 1800, 8_359_000],
    [1081, 1921, 1080, 1920, 7_071_000],
  ])("%ix%i", (w, h, rw, rh, bps) => {
    expect(renderSize(w, h)).toEqual([rw, rh]);
    expect(scaledBitrate(20_000_000, rw, rh)).toBe(bps);
  });
  it("never goes below 1 Mbps", () => {
    expect(scaledBitrate(20_000_000, 320, 240)).toBe(1_000_000);
  });
});

describe("quality options", () => {
  it("offers only sizes smaller than the source, never bigger", () => {
    expect(qualityOptions(2160, 3840).map((q) => [q.id, q.width, q.height])).toEqual([
      ["original", 2160, 3840],
      ["1080p", 1080, 1920],
      ["720p", 720, 1280],
    ]);
    expect(qualityOptions(1080, 1920).map((q) => q.id)).toEqual(["original", "720p"]);
    expect(qualityOptions(720, 1280).map((q) => q.id)).toEqual(["original"]);
    expect(qualityOptions(640, 360).map((q) => q.id)).toEqual(["original"]);
  });
  it("keeps the shape for other aspect ratios, in even sizes", () => {
    expect(sizeForShortSide(1440, 1800, 1080)).toEqual([1080, 1350]);
    expect(sizeForShortSide(3840, 1634, 720)).toEqual([1692, 720]);
  });
  it("ties the encoder's latency mode to the choice", () => {
    expect(qualityOptions(2160, 3840).map((q) => q.latencyMode)).toEqual(["quality", "quality", "realtime"]);
  });
  it("makes the preview 720p, or the source size when smaller", () => {
    expect(previewQuality(2160, 3840)).toMatchObject({ width: 720, height: 1280 });
    expect(previewQuality(640, 360)).toMatchObject({ width: 640, height: 360 });
    expect(previewQuality(2160, 3840).bitrate).toBeLessThan(scaledBitrate(20_000_000, 720, 1280));
  });
});

describe("pickQuality", () => {
  const opts = qualityOptions(2160, 3840);
  it("picks the best option that fits the time budget", () => {
    expect(pickQuality(opts, { original: 100, "1080p": 40, "720p": 20 })).toBe("original");
    expect(pickQuality(opts, { original: 400, "1080p": 150, "720p": 60 })).toBe("1080p");
  });
  it("falls back to the fastest when none fits, and to the original without estimates", () => {
    expect(pickQuality(opts, { original: 900, "1080p": 500, "720p": 300 })).toBe("720p");
    expect(pickQuality(opts, {})).toBe("original");
  });
});
