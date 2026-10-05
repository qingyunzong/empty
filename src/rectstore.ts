/**
 * rect-coverage-store
 *
 * A persistent (immutable-snapshot) spatial store for integer axis-aligned
 * rectangles. Each rectangle is stored under a caller-provided source id.
 * Mutations (`add` / `remove`) return a new store and never modify existing
 * snapshots. The `coverage(k)` query decomposes the region covered by at
 * least `k` rectangles into a canonical set of disjoint rectangles, each
 * annotated with the exact set of source ids covering it. Holes (regions
 * covered by fewer than `k` sources) are preserved: output rectangles never
 * span across them.
 *
 * The query uses a sweep-line algorithm. All endpoint events sharing the
 * same coordinate are applied as a single batch between slabs, so touching
 * rectangles never produce zero-width slabs or spurious splits.
 */

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export type RectId = string | number;

export interface CoverageRect<Id extends RectId = RectId> {
  readonly rect: Rect;
  /** Canonical (sorted) set of source ids covering `rect`. */
  readonly sources: readonly Id[];
}

export function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  const r: Rect = { x0, y0, x1, y1 };
  validateRect(r);
  return r;
}

export function validateRect(r: Rect): void {
  for (const key of ["x0", "y0", "x1", "y1"] as const) {
    if (!Number.isInteger(r[key])) {
      throw new RangeError(`rect.${key} must be an integer, got ${r[key]}`);
    }
  }
  if (!(r.x0 < r.x1) || !(r.y0 < r.y1)) {
    throw new RangeError(
      `rect must have positive area (x0<x1, y0<y1), got (${r.x0},${r.y0},${r.x1},${r.y1})`,
    );
  }
}

export function areaOf(r: Rect): number {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}

/** Canonical total order for ids: numbers ascending, then strings lexicographic. */
export function compareIds(a: RectId, b: RectId): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class RectStore<Id extends RectId = RectId> {
  private readonly rects: ReadonlyMap<Id, Rect>;

  private constructor(rects: ReadonlyMap<Id, Rect>) {
    this.rects = rects;
  }

  static empty<Id extends RectId = RectId>(): RectStore<Id> {
    return new RectStore<Id>(new Map());
  }

  get size(): number {
    return this.rects.size;
  }

  has(id: Id): boolean {
    return this.rects.has(id);
  }

  get(id: Id): Rect | undefined {
    return this.rects.get(id);
  }

  /** Snapshot of the current entries, sorted canonically by id. */
  entries(): readonly (readonly [Id, Rect])[] {
    return [...this.rects.entries()].sort(([a], [b]) => compareIds(a, b));
  }

  /**
   * Returns a new store with `rect` stored under `id` (replacing any
   * existing rectangle for that id). This store is left unchanged.
   */
  add(id: Id, r: Rect): RectStore<Id> {
    validateRect(r);
    const next = new Map(this.rects);
    next.set(id, Object.freeze({ ...r }));
    return new RectStore(next);
  }

  /**
   * Returns a new store without `id`. Removing a missing id is a no-op and
   * returns this same snapshot. This store is left unchanged.
   */
  remove(id: Id): RectStore<Id> {
    if (!this.rects.has(id)) return this;
    const next = new Map(this.rects);
    next.delete(id);
    return new RectStore(next);
  }

  /**
   * Canonical disjoint decomposition of the region covered by at least `k`
   * source rectangles. Each output rectangle carries the exact set of source
   * ids covering it. Output is sorted by (x0, y0, x1, y1) and is independent
   * of insertion order.
   */
  coverage(k: number): CoverageRect<Id>[] {
    return computeCoverage(this.rects, k);
  }
}

interface XBatch<Id extends RectId> {
  add: [Id, Rect][];
  del: Id[];
}

interface OpenRect<Id extends RectId> {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sources: Id[];
}

function computeCoverage<Id extends RectId>(
  rects: ReadonlyMap<Id, Rect>,
  k: number,
): CoverageRect<Id>[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`k must be a positive integer, got ${k}`);
  }
  if (rects.size === 0) return [];

  // Batch all x endpoint events by coordinate.
  const xEvents = new Map<number, XBatch<Id>>();
  const xBatch = (x: number): XBatch<Id> => {
    let b = xEvents.get(x);
    if (!b) {
      b = { add: [], del: [] };
      xEvents.set(x, b);
    }
    return b;
  };
  for (const [id, r] of rects) {
    xBatch(r.x0).add.push([id, r]);
    xBatch(r.x1).del.push(id);
  }
  const xs = [...xEvents.keys()].sort((a, b) => a - b);

  const active = new Map<Id, Rect>();
  // Merge key -> rectangle still being extended along the sweep direction.
  const open = new Map<string, OpenRect<Id>>();
  const out: CoverageRect<Id>[] = [];
  let prevX: number | null = null;

  const closeMissing = (continued: Set<string>): void => {
    for (const [key, r] of open) {
      if (!continued.has(key)) {
        out.push(freezeCoverage(r));
        open.delete(key);
      }
    }
  };

  for (const x of xs) {
    if (prevX !== null && prevX < x) {
      const continued = new Set<string>();
      if (active.size > 0) {
        sweepSlabY(active, prevX, x, k, open, continued);
      }
      closeMissing(continued);
    }
    // Apply the whole endpoint batch at x between slabs.
    const batch = xEvents.get(x)!;
    for (const id of batch.del) active.delete(id);
    for (const [id, r] of batch.add) active.set(id, r);
    prevX = x;
  }
  closeMissing(new Set());

  out.sort((a, b) => {
    const ra = a.rect;
    const rb = b.rect;
    return ra.x0 - rb.x0 || ra.y0 - rb.y0 || ra.x1 - rb.x1 || ra.y1 - rb.y1;
  });
  return out;
}

/**
 * Sweeps one x-slab [x0, x1) along y with the currently active rectangles.
 * Y endpoint events at the same coordinate are applied as one batch, and
 * contiguous y-runs with an identical source set are merged. Runs whose
 * (y-range, sources) match an open rectangle from the previous slab extend
 * it along x; otherwise a new open rectangle is started.
 */
function sweepSlabY<Id extends RectId>(
  active: ReadonlyMap<Id, Rect>,
  x0: number,
  x1: number,
  k: number,
  open: Map<string, OpenRect<Id>>,
  continued: Set<string>,
): void {
  const yEvents = new Map<number, { add: Id[]; del: Id[] }>();
  const yBatch = (y: number): { add: Id[]; del: Id[] } => {
    let b = yEvents.get(y);
    if (!b) {
      b = { add: [], del: [] };
      yEvents.set(y, b);
    }
    return b;
  };
  for (const [id, r] of active) {
    yBatch(r.y0).add.push(id);
    yBatch(r.y1).del.push(id);
  }
  const ys = [...yEvents.keys()].sort((a, b) => a - b);

  const current = new Set<Id>();
  let prevY: number | null = null;

  for (const y of ys) {
    if (prevY !== null && prevY < y && current.size >= k) {
      const sources = [...current].sort(compareIds);
      const key = `${prevY},${y},${JSON.stringify(sources)}`;
      continued.add(key);
      const existing = open.get(key);
      if (existing !== undefined && existing.x1 === x0) {
        existing.x1 = x1;
      } else {
        open.set(key, { x0, y0: prevY, x1, y1: y, sources });
      }
    }
    const batch = yEvents.get(y)!;
    for (const id of batch.del) current.delete(id);
    for (const id of batch.add) current.add(id);
    prevY = y;
  }
}

function freezeCoverage<Id extends RectId>(r: OpenRect<Id>): CoverageRect<Id> {
  return Object.freeze({
    rect: Object.freeze({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }),
    sources: Object.freeze([...r.sources]),
  });
}
