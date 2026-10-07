import { type TransitionTable, createTransitionTable, offsetAt } from "./table.js";
import {
  type LocalToUtcResult,
  type UtcToLocalResult,
  localToUtc,
  utcToLocal,
} from "./mapping.js";
import { type UtcIntervalSegment, localIntervalToUtc } from "./inverse.js";

/**
 * A zone holds the current transition table and swaps it atomically on
 * revision: the whole immutable table object is replaced in one step, never
 * mutated in place. Cursors created before a revision keep their bound table
 * and therefore keep producing old-table results; new cursors see the new
 * table.
 */
export class Zone {
  #state: { readonly table: TransitionTable; readonly version: number };

  constructor(table: TransitionTable) {
    this.#state = { table, version: 0 };
  }

  static fromTransitions(
    initialOffsetSeconds: number,
    transitions: readonly { atUtc: number; offsetSeconds: number }[],
  ): Zone {
    return new Zone(createTransitionTable(initialOffsetSeconds, transitions));
  }

  get version(): number {
    return this.#state.version;
  }

  get table(): TransitionTable {
    return this.#state.table;
  }

  /** Atomically replaces the transition table; returns the new version. */
  updateTable(table: TransitionTable): number {
    this.#state = { table, version: this.#state.version + 1 };
    return this.#state.version;
  }

  /** Binds a cursor to the table version current at this call. */
  cursor(): ZoneCursor {
    return new ZoneCursor(this.#state.table, this.#state.version);
  }
}

/** A read view pinned to one immutable table version of a Zone. */
export class ZoneCursor {
  readonly #table: TransitionTable;
  readonly version: number;

  constructor(table: TransitionTable, version: number) {
    this.#table = table;
    this.version = version;
  }

  get table(): TransitionTable {
    return this.#table;
  }

  offsetAt(utc: number): number {
    return offsetAt(this.#table, utc);
  }

  utcToLocal(utc: number): UtcToLocalResult {
    return utcToLocal(this.#table, utc);
  }

  localToUtc(local: number): LocalToUtcResult {
    return localToUtc(this.#table, local);
  }

  localIntervalToUtc(localStart: number, localEnd: number): UtcIntervalSegment[] {
    return localIntervalToUtc(this.#table, localStart, localEnd);
  }
}
