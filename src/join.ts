/**
 * Two-table inner join with duplicate keys, deterministic ordering and
 * version-bound keyset pagination.
 *
 * Semantics:
 * - Rows join on key equality; NULL keys never match (SQL semantics),
 *   not even NULL = NULL.
 * - Results are ordered by (key, leftId, rightId).
 * - A cursor pins the versions of BOTH tables plus the last emitted
 *   (key, leftId, rightId) triple. If either table has been modified
 *   since the cursor was issued, the cursor is stale and rejected:
 *   old pagination can never be mixed with new table contents.
 */

export type Key = number | string;
export type NullableKey = Key | null;

export interface Row {
  readonly id: number;
  readonly key: NullableKey;
}

export interface JoinTriple {
  readonly key: Key;
  readonly leftId: number;
  readonly rightId: number;
}

export interface Cursor {
  readonly leftVersion: number;
  readonly rightVersion: number;
  /** Last emitted triple; null when the cursor is a "from the start" cursor. */
  readonly last: readonly [Key, number, number] | null;
}

export interface JoinPage {
  readonly rows: JoinTriple[];
  /** Cursor to fetch the next page, or null when the result is exhausted. */
  readonly cursor: Cursor | null;
}

export class StaleCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleCursorError";
  }
}

/** Total order over keys: numbers sort before strings, each by value. */
export function compareKeys(a: Key, b: Key): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return typeof a === "number" ? -1 : 1;
}

export function compareTriples(a: JoinTriple, b: JoinTriple): number {
  return (
    compareKeys(a.key, b.key) ||
    a.leftId - b.leftId ||
    a.rightId - b.rightId
  );
}

/**
 * A mutable table of rows keyed by row id. Every mutation bumps `version`,
 * which invalidates any previously issued join cursor.
 */
export class Table {
  private readonly rows = new Map<number, Row>();
  private versionCounter = 0;

  get version(): number {
    return this.versionCounter;
  }

  insert(row: Row): void {
    if (this.rows.has(row.id)) {
      throw new Error(`duplicate row id ${row.id}`);
    }
    this.rows.set(row.id, { id: row.id, key: row.key });
    this.versionCounter += 1;
  }

  update(id: number, key: NullableKey): void {
    const existing = this.rows.get(id);
    if (existing === undefined) {
      throw new Error(`unknown row id ${id}`);
    }
    this.rows.set(id, { id, key });
    this.versionCounter += 1;
  }

  delete(id: number): void {
    if (!this.rows.delete(id)) {
      throw new Error(`unknown row id ${id}`);
    }
    this.versionCounter += 1;
  }

  /** Immutable point-in-time copy of all rows. */
  snapshot(): Row[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
}

/**
 * Full inner join of two row snapshots, sorted by (key, leftId, rightId).
 * NULL keys never match. Also serves as the reference implementation.
 */
export function fullJoin(leftRows: readonly Row[], rightRows: readonly Row[]): JoinTriple[] {
  const rightByKey = new Map<Key, number[]>();
  for (const row of rightRows) {
    if (row.key === null) continue;
    const bucket = rightByKey.get(row.key);
    if (bucket === undefined) {
      rightByKey.set(row.key, [row.id]);
    } else {
      bucket.push(row.id);
    }
  }

  const out: JoinTriple[] = [];
  for (const left of leftRows) {
    if (left.key === null) continue;
    const matches = rightByKey.get(left.key);
    if (matches === undefined) continue;
    for (const rightId of matches) {
      out.push({ key: left.key, leftId: left.id, rightId });
    }
  }
  out.sort(compareTriples);
  return out;
}

export interface JoinOptions {
  /** Maximum number of triples to return. Defaults to all remaining rows. */
  readonly limit?: number;
  /** Cursor from a previous page; omit to start from the beginning. */
  readonly cursor?: Cursor;
}

/**
 * Execute the inner join of `left` and `right`, returning at most
 * `options.limit` triples in (key, leftId, rightId) order, resuming
 * strictly after `options.cursor.last` when a cursor is supplied.
 *
 * @throws {StaleCursorError} if the cursor's pinned versions do not match
 *         the current versions of both tables.
 */
export function joinQuery(left: Table, right: Table, options: JoinOptions = {}): JoinPage {
  const cursor = options.cursor;
  if (cursor !== undefined) {
    if (cursor.leftVersion !== left.version || cursor.rightVersion !== right.version) {
      throw new StaleCursorError(
        `stale cursor: pinned versions (left=${cursor.leftVersion}, right=${cursor.rightVersion}) ` +
          `do not match current versions (left=${left.version}, right=${right.version})`,
      );
    }
  }

  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit < 0) {
    throw new RangeError("limit must be non-negative");
  }

  const sorted = fullJoin(left.snapshot(), right.snapshot());

  let start = 0;
  if (cursor?.last != null) {
    const [key, leftId, rightId] = cursor.last;
    const pivot: JoinTriple = { key, leftId, rightId };
    // First index strictly greater than the cursor's last triple.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareTriples(sorted[mid]!, pivot) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    start = lo;
  }

  const rows = sorted.slice(start, start + limit);
  const exhausted = start + rows.length >= sorted.length;

  const lastRow = rows[rows.length - 1];
  const nextCursor: Cursor | null = exhausted
    ? null
    : {
        leftVersion: left.version,
        rightVersion: right.version,
        last:
          lastRow === undefined
            ? (cursor?.last ?? null)
            : [lastRow.key, lastRow.leftId, lastRow.rightId],
      };

  return { rows, cursor: nextCursor };
}
