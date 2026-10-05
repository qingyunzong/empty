/**
 * rectdb: spatial store for integer axis-aligned rectangles.
 *
 * - Rectangles are half-open: [x0, x1) x [y0, y1), integer coordinates.
 * - Every insert/delete returns a NEW snapshot; previously returned
 *   snapshots are never modified (persistent / copy-on-write).
 * - coveredAtLeast(k) decomposes the region covered by at least k stored
 *   rectangles into a canonical set of pairwise-disjoint rectangles, each
 *   annotated with the sorted set of source ids covering it. Regions with
 *   coverage < k are simply absent from the output, so holes are preserved.
 * - The decomposition is canonical: it depends only on the multiset of
 *   stored (rect, source) pairs, never on insertion/deletion order.
 *   It is produced by a sweep line over x whose endpoint events are
 *   processed in batches per coordinate; each x-slab is decomposed by a
 *   batched sweep over y, and adjacent slabs with identical bands
 *   (same y-intervals and same source sets) are merged horizontally.
 */

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface CoveredRect extends Rect {
  /** Sorted, de-duplicated source ids covering every point of this rect. */
  readonly sources: readonly string[];
}

export interface Entry {
  readonly id: number;
  readonly rect: Rect;
  readonly source: string;
}

function assertValidRect(rect: Rect): void {
  const { x0, y0, x1, y1 } = rect;
  if (!Number.isInteger(x0) || !Number.isInteger(y0) ||
      !Number.isInteger(x1) || !Number.isInteger(y1)) {
    throw new RangeError(`rect coordinates must be integers: ${JSON.stringify(rect)}`);
  }
  if (!(x0 < x1) || !(y0 < y1)) {
    throw new RangeError(`rect must satisfy x0 < x1 and y0 < y1: ${JSON.stringify(rect)}`);
  }
}

interface Band {
  readonly y0: number;
  readonly y1: number;
  readonly sources: readonly string[];
}

interface OpenRect {
  readonly x0: number;
  readonly y0: number;
  readonly y1: number;
  readonly sources: readonly string[];
}

function sameBands(a: readonly Band[], b: readonly Band[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ba = a[i]!;
    const bb = b[i]!;
    if (ba.y0 !== bb.y0 || ba.y1 !== bb.y1) return false;
    if (ba.sources.length !== bb.sources.length) return false;
    for (let j = 0; j < ba.sources.length; j++) {
      if (ba.sources[j] !== bb.sources[j]) return false;
    }
  }
  return true;
}

/**
 * 1D batched sweep over y for the currently active entries.
 * Returns the maximal y-intervals whose covering source set has size >= k,
 * each annotated with its sorted source set.
 */
function computeBands(active: ReadonlyMap<number, Entry>, k: number): Band[] {
  const addAt = new Map<number, Entry[]>();
  const delAt = new Map<number, Entry[]>();
  for (const entry of active.values()) {
    const { y0, y1 } = entry.rect;
    let la = addAt.get(y0);
    if (la === undefined) addAt.set(y0, (la = []));
    la.push(entry);
    let ld = delAt.get(y1);
    if (ld === undefined) delAt.set(y1, (ld = []));
    ld.push(entry);
  }
  const ys = [...new Set([...addAt.keys(), ...delAt.keys()])].sort((a, b) => a - b);

  const bands: Band[] = [];
  const counts = new Map<string, number>(); // source -> active rect count
  let prevY: number | null = null;
  for (const y of ys) {
    if (prevY !== null && y > prevY && counts.size >= k) {
      const sources = [...counts.keys()].sort();
      const last = bands.length > 0 ? bands[bands.length - 1]! : null;
      if (last !== null && last.y1 === prevY &&
          last.sources.length === sources.length &&
          last.sources.every((s, j) => s === sources[j])) {
        // Same covering set continues: extend the previous band.
        bands[bands.length - 1] = { y0: last.y0, y1: y, sources: last.sources };
      } else {
        bands.push({ y0: prevY, y1: y, sources });
      }
    }
    // Batch: apply every endpoint event at this coordinate together.
    const dels = delAt.get(y);
    if (dels !== undefined) {
      for (const e of dels) {
        const n = counts.get(e.source);
        if (n !== undefined) {
          if (n === 1) counts.delete(e.source);
          else counts.set(e.source, n - 1);
        }
      }
    }
    const adds = addAt.get(y);
    if (adds !== undefined) {
      for (const e of adds) counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
    }
    prevY = y;
  }
  return bands;
}

export class RectSnapshot {
  private constructor(
    private readonly entries: ReadonlyMap<number, Entry>,
    private readonly nextId: number,
  ) {}

  static empty(): RectSnapshot {
    return new RectSnapshot(new Map(), 0);
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  get(id: number): Entry | undefined {
    return this.entries.get(id);
  }

  /** All stored entries, ordered by id. The result is a fresh array. */
  list(): Entry[] {
    return [...this.entries.values()];
  }

  /**
   * Insert a rectangle attributed to `source`.
   * Returns the new snapshot and the id assigned to the stored rectangle.
   * `this` is not modified.
   */
  insert(rect: Rect, source: string): { snapshot: RectSnapshot; id: number } {
    assertValidRect(rect);
    const id = this.nextId;
    const entries = new Map(this.entries);
    entries.set(id, { id, rect, source });
    return { snapshot: new RectSnapshot(entries, id + 1), id };
  }

  /**
   * Remove a previously inserted rectangle by id.
   * Returns the new snapshot; `this` is not modified.
   */
  remove(id: number): RectSnapshot {
    if (!this.entries.has(id)) {
      throw new RangeError(`no rectangle with id ${id}`);
    }
    const entries = new Map(this.entries);
    entries.delete(id);
    return new RectSnapshot(entries, this.nextId);
  }

  /**
   * Canonical disjoint decomposition of the region covered by at least k
   * stored rectangles. Holes (coverage < k) are omitted. Output order is
   * deterministic: ascending x0, then ascending y0.
   */
  coveredAtLeast(k: number): CoveredRect[] {
    if (!Number.isInteger(k) || k < 1) {
      throw new RangeError(`k must be a positive integer, got ${k}`);
    }

    // Batch x endpoint events per coordinate.
    const addAt = new Map<number, Entry[]>();
    const delAt = new Map<number, Entry[]>();
    for (const entry of this.entries.values()) {
      const { x0, x1 } = entry.rect;
      let la = addAt.get(x0);
      if (la === undefined) addAt.set(x0, (la = []));
      la.push(entry);
      let ld = delAt.get(x1);
      if (ld === undefined) delAt.set(x1, (ld = []));
      ld.push(entry);
    }
    const xs = [...new Set([...addAt.keys(), ...delAt.keys()])].sort((a, b) => a - b);

    const out: CoveredRect[] = [];
    const active = new Map<number, Entry>();
    let open: OpenRect[] = []; // rects of the previous slab, still extendable
    let prevX: number | null = null;

    const closeOpen = (x1: number): void => {
      for (const r of open) {
        out.push({ x0: r.x0, y0: r.y0, x1, y1: r.y1, sources: r.sources });
      }
      open = [];
    };

    for (const x of xs) {
      if (prevX !== null && x > prevX && active.size > 0) {
        const bands = computeBands(active, k);
        if (open.length > 0 && sameBands(open, bands)) {
          // Identical bands: previous rects extend through this slab.
        } else {
          closeOpen(prevX);
          const slabX = prevX;
          open = bands.map((b) => ({ x0: slabX, y0: b.y0, y1: b.y1, sources: b.sources }));
        }
      } else if (prevX !== null && x > prevX) {
        closeOpen(prevX);
      }
      // Batch: apply every endpoint event at this coordinate together.
      const dels = delAt.get(x);
      if (dels !== undefined) for (const e of dels) active.delete(e.id);
      const adds = addAt.get(x);
      if (adds !== undefined) for (const e of adds) active.set(e.id, e);
      prevX = x;
    }
    // Flush rects still open at the final event coordinate.
    if (prevX !== null) closeOpen(prevX);
    return out;
  }
}

export function emptySnapshot(): RectSnapshot {
  return RectSnapshot.empty();
}
