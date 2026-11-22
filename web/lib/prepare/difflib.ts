// Python's difflib.SequenceMatcher (get_matching_blocks and ratio), which scripts/vt.py uses to tie the script's
// words to the aligner's (cmd_analyze, autojunk off) and to tell whether the name check changed more than names
// (fix_names, autojunk on). A line-by-line port of CPython's Lib/difflib.py, without isjunk (vt.py never passes
// one). Elements compare by value: strings (words) or single characters (code points).

export type Block = [a: number, b: number, size: number];

export class SequenceMatcher<T extends string> {
  private b2j = new Map<T, number[]>();

  constructor(private a: readonly T[], private b: readonly T[], autojunk = true) {
    this.b.forEach((elt, i) => {
      const idx = this.b2j.get(elt);
      if (idx) idx.push(i);
      else this.b2j.set(elt, [i]);
    });
    // popular elements (no junk without isjunk)
    const n = b.length;
    if (autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of [...this.b2j]) if (idxs.length > ntest) this.b2j.delete(elt);
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // extend by equal (non-junk: there is no junk) elements on each end; popular ones count here
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Block[] {
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const out: Block[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return out;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((n, [, , k]) => n + k, 0);
    const length = this.a.length + this.b.length;
    return length ? (2.0 * matches) / length : 1.0;
  }
}

/** SequenceMatcher(None, a, b).ratio() of two strings (by code point, as Python indexes them). */
export const stringRatio = (a: string, b: string) => new SequenceMatcher(Array.from(a), Array.from(b)).ratio();
