import { encodeKey, type Key } from "./key";
import { toBigInt, type IngestResult, type PivotEvent } from "./events";

/** Current effective state of one inserted record. */
export interface RecordState {
  readonly insertId: string;
  readonly row: Key;
  readonly col: Key;
  readonly value: bigint;
}

/** Aggregate for one live leaf group (full row key x full col key). */
export interface LeafAggregate {
  readonly row: Key;
  readonly col: Key;
  readonly sum: bigint;
  readonly count: number;
}

function leafId(row: Key, col: Key): string {
  // JSON tuple keeps the two encoded keys unambiguously separated even when
  // user key parts contain separator-like characters.
  return JSON.stringify([encodeKey(row), encodeKey(col)]);
}

/**
 * Event-sourced pivot store.
 *
 * - Every event carries a unique id; re-ingesting the same id is a no-op,
 *   so corrections are idempotent and safe to retry.
 * - Aggregates are maintained incrementally on the leaf level; subtotals
 *   are derived by rolling leaves up (see pivot.ts), so leaf data is never
 *   double counted.
 */
export class PivotStore {
  private readonly seen = new Set<string>();
  private readonly records = new Map<string, RecordState>();
  private readonly leafMap = new Map<string, LeafAggregate>();

  ingest(event: PivotEvent): IngestResult {
    if (this.seen.has(event.id)) return { applied: false, reason: "duplicate-event-id" };
    switch (event.kind) {
      case "insert": {
        const state: RecordState = {
          insertId: event.id,
          row: event.row,
          col: event.col,
          value: toBigInt(event.value),
        };
        this.seen.add(event.id);
        this.records.set(event.id, state);
        this.bump(state.row, state.col, state.value, 1);
        return { applied: true };
      }
      case "adjust": {
        const target = this.records.get(event.target);
        if (!target) return { applied: false, reason: "unknown-target" };
        const delta = toBigInt(event.delta);
        this.seen.add(event.id);
        this.bump(target.row, target.col, delta, 0);
        this.records.set(event.target, { ...target, value: target.value + delta });
        return { applied: true };
      }
      case "move": {
        const target = this.records.get(event.target);
        if (!target) return { applied: false, reason: "unknown-target" };
        const row = event.row ?? target.row;
        const col = event.col ?? target.col;
        this.seen.add(event.id);
        this.bump(target.row, target.col, -target.value, -1);
        this.bump(row, col, target.value, 1);
        this.records.set(event.target, { ...target, row, col });
        return { applied: true };
      }
    }
  }

  ingestAll(events: Iterable<PivotEvent>): void {
    for (const event of events) this.ingest(event);
  }

  private bump(row: Key, col: Key, sumDelta: bigint, countDelta: number): void {
    const id = leafId(row, col);
    const prev = this.leafMap.get(id);
    const next = {
      row,
      col,
      sum: (prev?.sum ?? 0n) + sumDelta,
      count: (prev?.count ?? 0) + countDelta,
    };
    if (next.count === 0) {
      // The group became empty (all records migrated away). Drop it so a
      // stale zero can never be mistaken for a live zero-sum group.
      this.leafMap.delete(id);
    } else {
      this.leafMap.set(id, next);
    }
  }

  /** Live leaf groups. Groups with zero remaining records are absent. */
  leaves(): ReadonlyMap<string, LeafAggregate> {
    return this.leafMap;
  }

  /** Effective records (the "table" a full GROUP BY would run over). */
  effectiveRecords(): readonly RecordState[] {
    return [...this.records.values()];
  }

  static leafId(row: Key, col: Key): string {
    return leafId(row, col);
  }
}
