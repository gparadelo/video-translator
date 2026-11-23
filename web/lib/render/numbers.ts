// Number handling that has to match Python (the old Python pipeline) and ffmpeg bit for bit, because the browser
// renders from the same plan and must pick the same frames.

export type Rational = { num: number; den: number };

/**
 * Python's f"{x:.{digits}f}": the exact value of the double, rounded half to even. (JS toFixed rounds exact
 * ties up, e.g. 1.03125 -> "1.0313" where Python gives "1.0312".)
 */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) throw new Error(`can't format ${x}`);
  const neg = x < 0 || Object.is(x, -0);
  // toFixed(100) is the exact decimal value of every double from about 1e-15 up (all we format here).
  const exact = Math.abs(x).toFixed(100);
  const [int, frac] = exact.split(".");
  const keep = frac.slice(0, digits);
  const rest = frac.slice(digits);
  let digitsStr = int + keep; // as an integer string, `digits` decimals implied
  const half = rest[0] > "5" || (rest[0] === "5" && /[1-9]/.test(rest.slice(1)));
  const tie = rest[0] === "5" && !/[1-9]/.test(rest.slice(1));
  const lastOdd = Number(digitsStr[digitsStr.length - 1]) % 2 === 1;
  if (half || (tie && lastOdd)) digitsStr = (BigInt(digitsStr) + BigInt(1)).toString().padStart(digitsStr.length, "0");
  const intPart = digits ? digitsStr.slice(0, digitsStr.length - digits) || "0" : digitsStr;
  const out = digits ? `${intPart}.${digitsStr.slice(-digits)}` : intPart;
  return neg && /[1-9]/.test(out) ? `-${out}` : out;
}

/** Round half away from zero (ffmpeg's AV_ROUND_NEAR_INF) of num / den, for integers. */
export function divRoundNear(num: bigint, den: bigint): bigint {
  if (den < BigInt(0)) return divRoundNear(-num, -den);
  const neg = num < BigInt(0);
  const a = neg ? -num : num;
  const q = (BigInt(2) * a + den) / (BigInt(2) * den);
  return neg ? -q : q;
}

const big = (x: number) => BigInt(x);

/** ffmpeg's av_reduce: the closest fraction to num/den with numerator and denominator at most `max`. */
export function avReduce(num: bigint, den: bigint, max: bigint): Rational {
  const abs = (v: bigint) => (v < BigInt(0) ? -v : v);
  let a0n = BigInt(0), a0d = BigInt(1), a1n = BigInt(1), a1d = BigInt(0);
  const sign = (num < BigInt(0)) !== (den < BigInt(0));
  const gcd = (a: bigint, b: bigint): bigint => (b === BigInt(0) ? a : gcd(b, a % b));
  const g = gcd(abs(num), abs(den));
  if (g) {
    num = abs(num) / g;
    den = abs(den) / g;
  }
  if (num <= max && den <= max) {
    a1n = num;
    a1d = den;
    den = BigInt(0);
  }
  while (den) {
    let x = num / den;
    const nextDen = num - den * x;
    const a2n = x * a1n + a0n;
    const a2d = x * a1d + a0d;
    if (a2n > max || a2d > max) {
      if (a1n) x = (max - a0n) / a1n;
      if (a1d) {
        const y = (max - a0d) / a1d;
        if (y < x) x = y;
      }
      if (den * (BigInt(2) * x * a1d + a0d) > num * a1d) {
        a1n = x * a1n + a0n;
        a1d = x * a1d + a0d;
      }
      break;
    }
    a0n = a1n;
    a0d = a1d;
    a1n = a2n;
    a1d = a2d;
    num = den;
    den = nextDen;
  }
  return { num: Number(sign ? -a1n : a1n), den: Number(a1d) };
}

/**
 * The frame rate ffmpeg uses for `fps=<x>` when x is a decimal (the old Python pipeline writes the float, e.g. 29.97002997002997):
 * av_parse_video_rate -> av_d2q(x, 1001000). 29.97002997002997 -> 30000/1001, 30.0 -> 30/1.
 */
export function ffmpegRate(fps: number): Rational {
  if (!(fps > 0) || !Number.isFinite(fps)) throw new Error(`bad frame rate ${fps}`);
  // frexp(fps) - 1, at least 0: floor(log2(fps)), counted exactly (Math.log2 can land just below a power of two)
  let exponent = 0;
  while (2 ** (exponent + 1) <= fps) exponent++;
  const den = BigInt(2) ** BigInt(62 - exponent);
  // fps * 2^(62-exponent) is an exact integer-valued double (multiplying by a power of two), below 2^63.
  const scaled = Math.floor(fps * 2 ** (62 - exponent) + 0.5);
  return avReduce(BigInt(scaled), den, big(1001000));
}
