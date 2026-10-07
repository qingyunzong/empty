import { createTransitionTable, offsetAt } from "./table.js";
import { localToUtc, utcToLocal, } from "./mapping.js";
import { localIntervalToUtc } from "./inverse.js";
/**
 * A zone holds the current transition table and swaps it atomically on
 * revision: the whole immutable table object is replaced in one step, never
 * mutated in place. Cursors created before a revision keep their bound table
 * and therefore keep producing old-table results; new cursors see the new
 * table.
 */
export class Zone {
    #state;
    constructor(table) {
        this.#state = { table, version: 0 };
    }
    static fromTransitions(initialOffsetSeconds, transitions) {
        return new Zone(createTransitionTable(initialOffsetSeconds, transitions));
    }
    get version() {
        return this.#state.version;
    }
    get table() {
        return this.#state.table;
    }
    /** Atomically replaces the transition table; returns the new version. */
    updateTable(table) {
        this.#state = { table, version: this.#state.version + 1 };
        return this.#state.version;
    }
    /** Binds a cursor to the table version current at this call. */
    cursor() {
        return new ZoneCursor(this.#state.table, this.#state.version);
    }
}
/** A read view pinned to one immutable table version of a Zone. */
export class ZoneCursor {
    #table;
    version;
    constructor(table, version) {
        this.#table = table;
        this.version = version;
    }
    get table() {
        return this.#table;
    }
    offsetAt(utc) {
        return offsetAt(this.#table, utc);
    }
    utcToLocal(utc) {
        return utcToLocal(this.#table, utc);
    }
    localToUtc(local) {
        return localToUtc(this.#table, local);
    }
    localIntervalToUtc(localStart, localEnd) {
        return localIntervalToUtc(this.#table, localStart, localEnd);
    }
}
