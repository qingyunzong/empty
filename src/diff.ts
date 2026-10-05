/**
 * Line-based diff engine.
 *
 * For short sequences (base length <= EXHAUSTIVE_LIMIT) the minimal edit
 * script is found by exhaustively enumerating every direct edit combination
 * (every subset of base lines to delete; the required insertions are then
 * fully determined) and picking the first — therefore minimal — one whose
 * result matches the target. Longer inputs fall back to Myers O(ND).
 */

export interface Hunk {
  /** Inclusive start line index into the base document. */
  baseStart: number;
  /** Exclusive end line index into the base document. */
  baseEnd: number;
  /** Replacement lines (empty for a pure deletion). */
  lines: string[];
}

export type Op = 'keep' | 'del' | 'ins';

/** Base sequences up to this many lines are diffed by exhaustive enumeration. */
export const EXHAUSTIVE_LIMIT = 12;

/** Apply hunks (sorted, non-overlapping) to `base`; returns the new lines. */
export function applyHunks(base: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.baseStart), ...h.lines);
    pos = h.baseEnd;
  }
  out.push(...base.slice(pos));
  return out;
}

/** Coalesce a keep/del/ins op stream into hunks over base coordinates. */
export function opsToHunks(a: string[], b: string[], ops: Op[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op === 'keep') {
      cur = null;
      i++;
      j++;
      continue;
    }
    if (!cur) {
      cur = { baseStart: i, baseEnd: i, lines: [] };
      hunks.push(cur);
    }
    if (op === 'del') {
      cur.baseEnd++;
      i++;
    } else {
      cur.lines.push(b[j]);
      j++;
    }
  }
  return hunks;
}

/** Total number of edit operations implied by a hunk list. */
export function editCount(hunks: Hunk[]): number {
  let n = 0;
  for (const h of hunks) n += h.baseEnd - h.baseStart + h.lines.length;
  return n;
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let k = 0;
  for (const line of haystack) {
    if (k < needle.length && line === needle[k]) k++;
  }
  return k === needle.length;
}

/** Yield every size-`d` subset of {0..n-1} as a boolean deletion mask. */
function* deleteMasks(n: number, d: number): Generator<boolean[]> {
  const idx: number[] = [];
  for (let i = 0; i < d; i++) idx.push(i);
  const mask = new Array<boolean>(n).fill(false);
  for (let i = 0; i < d; i++) mask[i] = true;
  for (;;) {
    yield mask.slice();
    // next combination (lexicographic on positions)
    let p = d - 1;
    while (p >= 0 && idx[p] === n - d + p) p--;
    if (p < 0) return;
    idx[p]++;
    for (let q = p + 1; q < d; q++) idx[q] = idx[q - 1] + 1;
    mask.fill(false);
    for (const i of idx) mask[i] = true;
  }
}

/**
 * Exhaustive diff: enumerate deletion masks in increasing size; for each, the
 * surviving base lines must be a subsequence of `b`, in which case the
 * insertions are determined. Total edits = deletions + insertions
 * = d + (|b| - (|a| - d)), strictly increasing in d, so the first match is
 * a minimal edit script.
 */
export function exhaustiveOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  for (let d = 0; d <= n; d++) {
    for (const mask of deleteMasks(n, d)) {
      const kept: string[] = [];
      for (let i = 0; i < n; i++) if (!mask[i]) kept.push(a[i]);
      if (!isSubsequence(kept, b)) continue;
      // Build the op stream: deletions per mask, insertions wherever the
      // next b line does not match the next surviving a line.
      const ops: Op[] = [];
      let j = 0;
      for (let i = 0; i < n; i++) {
        if (mask[i]) {
          ops.push('del');
          continue;
        }
        while (b[j] !== a[i]) {
          ops.push('ins');
          j++;
        }
        ops.push('keep');
        j++;
      }
      while (j < b.length) {
        ops.push('ins');
        j++;
      }
      return ops;
    }
  }
  return a.map(() => 'del'); // unreachable: deleting everything always works
}

/** Myers O(ND) diff, returning a keep/del/ins op stream. */
export function myersOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const width = 2 * max + 1;
  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let found = 0;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vv[k - 1 + offset] < vv[k + 1 + offset])
        ? k + 1
        : k - 1;
    const prevX = vv[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('keep');
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push('ins');
      y--;
    } else {
      ops.push('del');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('keep');
    x--;
    y--;
  }
  return ops.reverse();
}

/** Diff `base` against `modified`; returns sorted, non-overlapping hunks. */
export function diffLines(base: string[], modified: string[]): Hunk[] {
  const ops =
    base.length <= EXHAUSTIVE_LIMIT
      ? exhaustiveOps(base, modified)
      : myersOps(base, modified);
  return opsToHunks(base, modified, ops);
}
