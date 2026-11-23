import { describe, expect, it } from "vitest";
import { clipDuration } from "./build";
import { FIT } from "./config";
import { parseInputs } from "./inputs";
import { pyFormat, pyRound, stripMarkers, words } from "./py";
import { encodeWav } from "./voice";
import { parseWav } from "../render/wav";

describe("Python behaviour", () => {
  it("round() halves to even", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001].map(pyRound)).toEqual([0, 2, 2, 0, -2, 2, 3]);
  });
  it("formats like f-strings", () => {
    expect(pyFormat(-0.001, 2)).toBe("-0.00");
    expect(pyFormat(0.125, 2)).toBe("0.12");
    expect(pyFormat(0.375, 2)).toBe("0.38");
    expect(pyFormat(0.004, 2, true)).toBe("+0.00");
    expect(pyFormat(-1.234, 2, true)).toBe("-1.23");
  });
  it("strips markers and splits words by code point", () => {
    const { clean, marks } = stripMarkers("{1}Hola {2}{3}mundo 😀 {1}fin");
    expect(clean.join("")).toBe("Hola mundo 😀 fin");
    expect([...marks]).toEqual([[1, 13], [2, 5], [3, 5]]); // a repeated marker keeps its place, takes the last index
    expect(words(clean)).toEqual([{ start: 0, end: 4 }, { start: 5, end: 10 }, { start: 11, end: 12 }, { start: 13, end: 16 }]);
    expect(words(Array.from("a b　c﻿d"))).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 7 }]);
  });
});

describe("clip duration", () => {
  it("is ffprobe's: whole microseconds", () => {
    expect(clipDuration(77824)).toBe(1.764717);
    expect(clipDuration(149504)).toBe(3.390113);
    expect(clipDuration(145530)).toBe(3.3);
  });
});

describe("WAV", () => {
  it("round-trips", () => {
    const d = Int16Array.from([1, -2, 3, -32768, 32767, 0]);
    const w = parseWav(encodeWav(d, 44100, 2));
    expect(w).toMatchObject({ sampleRate: 44100, channels: 2, frames: 3 });
    expect([...w.data]).toEqual([...d]);
  });
});

describe("parseInputs", () => {
  const ok = {
    format: 1, lang: "de", voice_id: "v",
    analysis: { video: { dur: 10, fps: 30 }, source: { width: 1080, height: 1920 }, speech_start: 0.5, speech_end: 9,
                base_lufs: -16, beats: [{ id: 1, dur: 8, pause_after: 0 }], tokens: [{ beat: 0 }],
                anchors: [{ id: 1, t: 2, kind: "in", token: 0, frac: 0.5 }] },
    fit: FIT, script: [{ id: 1, text: "{1}Hallo" }], clips: [{ beat: 1, file: "0123abcd.mp3", speed: 1 }],
  };
  it("accepts what vt.plan_inputs writes", () => expect(parseInputs(ok).lang).toBe("de"));
  it("refuses other formats, paths and broken references", () => {
    expect(() => parseInputs({ ...ok, format: 2 })).toThrow(/format 2/);
    expect(() => parseInputs({ ...ok, clips: [{ beat: 1, file: "../x.mp3", speed: 1 }] })).toThrow(/clip/);
    expect(() => parseInputs({ ...ok, analysis: { ...ok.analysis, anchors: [{ id: 1, t: 2, kind: "in", token: 5, frac: 0 }] } })).toThrow(/word/);
    expect(() => parseInputs({ ...ok, script: [] })).toThrow(/beats/);
  });
});
