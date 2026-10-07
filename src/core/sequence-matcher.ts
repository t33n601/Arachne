/**
 * The parts of Python's `difflib.SequenceMatcher` the tracking features rely on (`ratio()` with the default
 * `autojunk` heuristic), so similarity scores are identical to difflib's.
 */

type Item = string | number | boolean | null;
type Sequence = string | readonly Item[];

interface Match {
  a: number;
  b: number;
  size: number;
}

function toArray(seq: Sequence): readonly Item[] {
  return typeof seq === "string" ? Array.from(seq) : seq;
}

export class SequenceMatcher {
  private readonly a: readonly Item[];
  private readonly b: readonly Item[];
  private readonly b2j = new Map<Item, number[]>();
  private matchingBlocks: Match[] | null = null;

  constructor(a: Sequence, b: Sequence, autojunk = true) {
    this.a = toArray(a);
    this.b = toArray(b);
    this.chainB(autojunk);
  }

  private chainB(autojunk: boolean): void {
    const b = this.b;
    b.forEach((elt, i) => {
      let indices = this.b2j.get(elt);
      if (!indices) {
        indices = [];
        this.b2j.set(elt, indices);
      }
      indices.push(i);
    });

    const n = b.length;
    if (autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, indices] of [...this.b2j]) {
        if (indices.length > ntest) this.b2j.delete(elt);
      }
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();

    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i]!) ?? [];
      for (const j of indices) {
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

    // No junk function is used, so matches are extended over any equal elements (popular ones included)
    const { b } = this;
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return { a: besti, b: bestj, size: bestsize };
  }

  getMatchingBlocks(): Match[] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Match[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const match = this.findLongestMatch(alo, ahi, blo, bhi);
      const { a: i, b: j, size: k } = match;
      if (k) {
        blocks.push(match);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x.a - y.a || x.b - y.b || x.size - y.size);

    // Collapse adjacent blocks
    const nonAdjacent: Match[] = [];
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    for (const { a: i2, b: j2, size: k2 } of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) nonAdjacent.push({ a: i1, b: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) nonAdjacent.push({ a: i1, b: j1, size: k1 });
    nonAdjacent.push({ a: la, b: lb, size: 0 });
    this.matchingBlocks = nonAdjacent;
    return nonAdjacent;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, block) => sum + block.size, 0);
    const length = this.a.length + this.b.length;
    return length ? (2 * matches) / length : 1;
  }
}

/** Shortcut for `new SequenceMatcher(a, b).ratio()` */
export function similarity(a: Sequence, b: Sequence): number {
  return new SequenceMatcher(a, b).ratio();
}
