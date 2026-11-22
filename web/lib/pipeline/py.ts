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

const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

/** Python's str.strip() (no arguments): whitespace as str.isspace() has it, from both ends. */
export const pyStrip = (s: string) => s.replace(PY_STRIP, "");

/** Python's len(str): code points, not UTF-16 units. */
export const pyLen = (s: string) => Array.from(s).length;

/** Python's repr(float) (and str(float)): the shortest digits that read back the same, "1.0" for whole numbers. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, e] = Math.abs(x).toExponential().split("e"); // the shortest round-trip digits, like Python's
  const digits = mant.replace(".", "");
  const exp = Number(e);
  if (exp < -4 || exp > 15) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

/** Python's round(x, digits) for a float: the exact value rounded half to even, as f"{x:.{digits}f}" does. */
export const pyRoundTo = (x: number, digits: number) => Number(pyFormat(x, digits));

/** A JSON string as Python's json.dumps writes it with ensure_ascii (the default): all but printable ASCII escaped. */
function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`; // UTF-16 units: pairs as two, like Python
    else out += ch;
  }
  return out + '"';
}

/**
 * Python's json.dumps(value, sort_keys=True) with its default separators (", " and ": "). Every number is
 * written as a Python float (repr), so use it only where the Python side has floats: vt.tts_beat's cache key,
 * where the voice settings and the speed are floats.
 */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return pyFloatRepr(value);
  }
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // sort_keys orders by code point; JS's sort compares UTF-16 units (the same for the ASCII keys used here)
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${pyJsonString(k)}: ${pyJsonDumps(o[k])}`).join(", ")}}`;
  }
  throw new Error(`can't write ${typeof value} as JSON`);
}

/** Python's repr of a list of ints: "[1, 2, 3]". */
export const pyIntList = (xs: number[]) => `[${xs.join(", ")}]`;
