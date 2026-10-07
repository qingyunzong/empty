import type { Ring } from './ring.js';

/**
 * A half-open key-hash interval `(from, to]` whose ownership changed between
 * two ring versions. `from === to` denotes the full circle (only possible
 * when the union of vnode points is a single point). When `from > to` the
 * interval wraps past the top of the uint32 hash space. `src`/`dst` are null
 * when the corresponding ring is empty.
 */
export interface MigrationInterval {
  from: number;
  to: number;
  src: string | null;
  dst: string | null;
}

/**
 * Exact key-interval diff between two ring versions: the precise set of
 * `(from, to]` hash intervals whose owner differs. Adjacent intervals with
 * the same (src, dst) pair are merged, including across the wrap point.
 */
export function planMigration(oldRing: Ring, newRing: Ring): MigrationInterval[] {
  const points = new Set<number>();
  for (const vnode of oldRing.vnodes) points.add(vnode.hash);
  for (const vnode of newRing.vnodes) points.add(vnode.hash);
  const sorted = [...points].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const changed: MigrationInterval[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const to = sorted[i];
    const from = i === 0 ? sorted[sorted.length - 1] : sorted[i - 1];
    // Every key hash in (from, to] has the same successor vnode: the head of
    // the collision group sitting at `to`.
    const src = oldRing.owner(to) ?? null;
    const dst = newRing.owner(to) ?? null;
    if (src !== dst) changed.push({ from, to, src, dst });
  }

  const merged: MigrationInterval[] = [];
  for (const interval of changed) {
    const last = merged[merged.length - 1];
    if (last && last.src === interval.src && last.dst === interval.dst && last.to === interval.from) {
      last.to = interval.to;
    } else {
      merged.push({ ...interval });
    }
  }
  if (merged.length > 1) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    if (first.src === last.src && first.dst === last.dst && last.to === first.from) {
      first.from = last.from;
      merged.pop();
    }
  }
  return merged;
}
