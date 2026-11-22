// Python's number and text behaviour where scripts/vt.py's results depend on it, so the timing plan built here
// comes out exactly as vt.py's (vt.py is the reference until the Python pipeline is removed).

import { pyFixed } from "../render/numbers";

/** Python's round(x) for a float: to the nearest integer, exact halves to the even one. */
export function pyRound(x: number): number {
  if (!Number.isFinite(x)) throw new Error(`can't round ${x}`);
  const f = Math.floor(x);
  const d = x - f; // exact for every double
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** C's lrint / lrintf in the default rounding mode: the same as pyRound. */
export const rint = pyRound;

/** f"{x:.{digits}f}" (and f"{x:+.{digits}f}" with plus), including Python's "-0.00" for small negatives. */
export function pyFormat(x: number, digits: number, plus = false): string {
  const neg = x < 0 || Object.is(x, -0);
  const body = pyFixed(Math.abs(x), digits);
  return (neg ? "-" : plus ? "+" : "") + body;
}

/** Python's str.isspace() characters, i.e. what `\s` matches in a Python str regex. */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD = new RegExp(`[^${PY_SPACE}]+`, "gu");

/**
 * Python's re.finditer(r"\S+", text) over a string given as code points (Python indexes strings by code
 * point; JS by UTF-16 unit): each run's [start, end) in code points.
 */
export function words(chars: string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const text = chars.join("");
  // map UTF-16 offsets back to code point indexes
  const cp = new Map<number, number>();
  let unit = 0;
  chars.forEach((c, i) => {
    cp.set(unit, i);
    unit += c.length;
  });
  cp.set(unit, chars.length);
  for (const m of text.matchAll(WORD)) out.push({ start: cp.get(m.index)!, end: cp.get(m.index + m[0].length)! });
  return out;
}

const MARK = /\{(\d+)\}/g;

/** vt.strip_markers: remove {n} markers; the clean text (as code points) and marker -> code point index in it. */
export function stripMarkers(s: string): { clean: string[]; marks: Map<number, number> } {
  const clean: string[] = [];
  const marks = new Map<number, number>();
  let pos = 0;
  for (const m of s.matchAll(MARK)) {
    clean.push(...Array.from(s.slice(pos, m.index)));
    marks.set(Number(m[1]), clean.length); // a repeated marker keeps its first place in the order, like a dict
    pos = m.index + m[0].length;
  }
  clean.push(...Array.from(s.slice(pos)));
  return { clean, marks };
}
