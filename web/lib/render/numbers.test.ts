import { describe, expect, it } from "vitest";
import { avReduce, divRoundNear, ffmpegRate, pyFixed } from "./numbers";

describe("pyFixed (Python's f-string rounding)", () => {
  it("rounds exact ties to even, like Python", () => {
    expect(pyFixed(1.03125, 4)).toBe("1.0312"); // JS toFixed gives 1.0313
    expect(pyFixed(1.03125, 5)).toBe("1.03125");
    expect(pyFixed(2.5, 0)).toBe("2");
    expect(pyFixed(3.5, 0)).toBe("4");
    expect(pyFixed(0.125, 2)).toBe("0.12");
  });
  it("rounds the double's exact value otherwise", () => {
    expect(pyFixed(5e-5, 4)).toBe("0.0001"); // 5e-05 is a hair above 0.00005
    expect(pyFixed(1.000049999, 5)).toBe("1.00005");
    expect(pyFixed(0.93117, 4)).toBe("0.9312");
    expect(pyFixed(1.0999999, 5)).toBe("1.10000");
    expect(pyFixed(0, 4)).toBe("0.0000");
    expect(pyFixed(12.9, 4)).toBe("12.9000");
    expect(pyFixed(-1.25, 1)).toBe("-1.2");
    expect(pyFixed(7071.07, 0)).toBe("7071");
  });
});

describe("ffmpeg's rational helpers", () => {
  it("rounds half away from zero", () => {
    expect(divRoundNear(BigInt(5), BigInt(2))).toBe(BigInt(3));
    expect(divRoundNear(BigInt(-5), BigInt(2))).toBe(BigInt(-3));
    expect(divRoundNear(BigInt(4), BigInt(3))).toBe(BigInt(1));
  });
  it("reduces fractions like av_reduce", () => {
    expect(avReduce(BigInt(60), BigInt(2), BigInt(1001000))).toEqual({ num: 30, den: 1 });
    expect(avReduce(BigInt(355), BigInt(113), BigInt(100))).toEqual({ num: 22, den: 7 });
  });
  it("parses frame rates the way the fps filter does", () => {
    expect(ffmpegRate(30)).toEqual({ num: 30, den: 1 });
    expect(ffmpegRate(25)).toEqual({ num: 25, den: 1 });
    expect(ffmpegRate(30000 / 1001)).toEqual({ num: 30000, den: 1001 });
    expect(ffmpegRate(24000 / 1001)).toEqual({ num: 24000, den: 1001 });
    expect(ffmpegRate(60000 / 1001)).toEqual({ num: 60000, den: 1001 });
    expect(ffmpegRate(120)).toEqual({ num: 120, den: 1 });
  });
});
