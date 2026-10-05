/**
 * Line-based diff.
 *
 * Two strategies:
 *  - exhaustiveOps: for short sequences (a.length * b.length <= LIMIT) it
 *    exhaustively evaluates every direct edit combination (keep / delete /
 *    insert at each position) via a full cost table, then walks back the
 *    minimal-cost script. This is the reference implementation.
 *  - myersOps: O(ND) Myers algorithm for larger inputs. Tests cross-check it
 *    against exhaustiveOps on randomized inputs.
 */

export interface Op {
  type: 'keep' | 'del' | 'ins';
  line: string;
}

/** A replacement of base[baseStart .. baseEnd) with `lines`. 0-based, half-open. */
export interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

/** Max cell count for the exhaustive (full cost-table) path. */
export const EXHAUSTIVE_CELL_LIMIT = 1_000_000;

export function diffOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length <= EXHAUSTIVE_CELL_LIMIT) return exhaustiveOps(a, b);
  return myersOps(a, b);
}

export function diffLines(base: string[], modified: string[]): Hunk[] {
  return opsToHunks(diffOps(base, modified));
}

/**
 * Exhaustively considers all direct edit combinations for short sequences.
 * cost[i][j] = minimal number of edits to turn a[i..] into b[j..]; every
 * combination of keep/delete/insert is priced in the table, and the walk
 * below picks a minimal script deterministically (prefer keep, then delete,
 * then insert).
 */
export function exhaustiveOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const cost = new Int32Array((n + 1) * width);
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n) {
        cost[i * width + j] = m - j;
      } else if (j === m) {
        cost[i * width + j] = n - i;
      } else {
        let best = Math.min(cost[(i + 1) * width + j], cost[i * width + j + 1]) + 1;
        if (a[i] === b[j]) best = Math.min(best, cost[(i + 1) * width + j + 1]);
        cost[i * width + j] = best;
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j] && cost[i * width + j] === cost[(i + 1) * width + j + 1]) {
      ops.push({ type: 'keep', line: a[i] });
      i++;
      j++;
    } else if (i < n && cost[i * width + j] === cost[(i + 1) * width + j] + 1) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'ins', line: b[j] });
      j++;
    }
  }
  return ops;
}

/** Classic Myers O(ND) greedy diff with backtrace. */
export function myersOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let dFinal = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    let done = false;
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
        done = true;
        break;
      }
    }
    if (done) {
      dFinal = d;
      break;
    }
  }
  const reversed: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dFinal; d >= 1; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vv[k - 1 + offset] < vv[k + 1 + offset]) ? k + 1 : k - 1;
    const prevX = vv[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: 'keep', line: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      reversed.push({ type: 'ins', line: b[y - 1] });
      y--;
    } else {
      reversed.push({ type: 'del', line: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ type: 'keep', line: a[x - 1] });
    x--;
    y--;
  }
  return reversed.reverse();
}

/** Group an op stream into replacement hunks keyed by base line numbers. */
export function opsToHunks(ops: Op[]): Hunk[] {
  const hunks: Hunk[] = [];
  let baseIndex = 0;
  let current: Hunk | null = null;
  for (const op of ops) {
    if (op.type === 'keep') {
      baseIndex++;
      current = null;
      continue;
    }
    if (current === null) {
      current = { baseStart: baseIndex, baseEnd: baseIndex, lines: [] };
      hunks.push(current);
    }
    if (op.type === 'del') {
      current.baseEnd++;
      baseIndex++;
    } else {
      current.lines.push(op.line);
    }
  }
  return hunks;
}
