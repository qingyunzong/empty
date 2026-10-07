/**
 * Immutable offset transition table — the sole authority for local <-> UTC
 * mapping. The system timezone is never consulted.
 *
 * Effective offset rules form half-open UTC domains:
 *   rule 0: initialOffsetSeconds over (-Infinity, transitions[0].atUtc)
 *   rule k: transitions[k-1].offsetSeconds over
 *           [transitions[k-1].atUtc, transitions[k].atUtc)
 * All times are integer seconds.
 */
export interface Transition {
    readonly atUtc: number;
    readonly offsetSeconds: number;
}
export interface TransitionTable {
    readonly initialOffsetSeconds: number;
    readonly transitions: readonly Transition[];
}
/** One offset rule: a fixed offset over a half-open UTC domain [utcStart, utcEnd). */
export interface OffsetRule {
    readonly ruleIndex: number;
    readonly offsetSeconds: number;
    readonly utcStart: number;
    readonly utcEnd: number;
}
/**
 * Validates and deep-freezes a transition table.
 * Transitions must be strictly increasing in atUtc. A transition may repeat
 * the current offset (a redundant no-op rule); such rules are kept so table
 * revisions stay faithful to their input, and inverse-image merging treats
 * them as equivalent segments.
 */
export declare function createTransitionTable(initialOffsetSeconds: number, transitions: readonly Transition[]): TransitionTable;
export declare function ruleCount(table: TransitionTable): number;
export declare function ruleAt(table: TransitionTable, ruleIndex: number): OffsetRule;
export declare function rules(table: TransitionTable): Generator<OffsetRule>;
/** Index of the offset rule in effect at the given UTC second (binary search). */
export declare function ruleIndexAt(table: TransitionTable, utc: number): number;
/** Offset (seconds ahead of UTC) in effect at the given UTC second. */
export declare function offsetAt(table: TransitionTable, utc: number): number;
