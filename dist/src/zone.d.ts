import { type TransitionTable } from "./table.js";
import { type LocalToUtcResult, type UtcToLocalResult } from "./mapping.js";
import { type UtcIntervalSegment } from "./inverse.js";
/**
 * A zone holds the current transition table and swaps it atomically on
 * revision: the whole immutable table object is replaced in one step, never
 * mutated in place. Cursors created before a revision keep their bound table
 * and therefore keep producing old-table results; new cursors see the new
 * table.
 */
export declare class Zone {
    #private;
    constructor(table: TransitionTable);
    static fromTransitions(initialOffsetSeconds: number, transitions: readonly {
        atUtc: number;
        offsetSeconds: number;
    }[]): Zone;
    get version(): number;
    get table(): TransitionTable;
    /** Atomically replaces the transition table; returns the new version. */
    updateTable(table: TransitionTable): number;
    /** Binds a cursor to the table version current at this call. */
    cursor(): ZoneCursor;
}
/** A read view pinned to one immutable table version of a Zone. */
export declare class ZoneCursor {
    #private;
    readonly version: number;
    constructor(table: TransitionTable, version: number);
    get table(): TransitionTable;
    offsetAt(utc: number): number;
    utcToLocal(utc: number): UtcToLocalResult;
    localToUtc(local: number): LocalToUtcResult;
    localIntervalToUtc(localStart: number, localEnd: number): UtcIntervalSegment[];
}
