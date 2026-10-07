import { type TransitionTable } from "./table.js";
/**
 * One half-open UTC interval of the inverse image, annotated with the offset
 * rule(s) it originates from. ruleIndices has more than one entry only when
 * equivalent adjacent segments (same offset, contiguous domains — e.g. across
 * a redundant same-offset transition) were merged.
 */
export interface UtcIntervalSegment {
    readonly utcStart: number;
    readonly utcEnd: number;
    readonly offsetSeconds: number;
    readonly ruleIndices: readonly number[];
}
/**
 * Inverse image of a local half-open interval [localStart, localEnd):
 * every UTC second u with localStart <= utcToLocal(u) < localEnd.
 *
 * Computed per offset rule as
 *   [max(ruleStart, localStart - o), min(ruleEnd, localEnd - o))
 * which splits the result wherever a transition is crossed. Gaps contribute
 * nothing (their local seconds have no preimage); overlaps contribute one
 * segment per covering rule. Adjacent segments sharing the same offset rule
 * are merged into one equivalent segment.
 *
 * Segments are returned sorted by utcStart, half-open and non-overlapping.
 */
export declare function localIntervalToUtc(table: TransitionTable, localStart: number, localEnd: number): UtcIntervalSegment[];
export interface InverseImageVerification {
    readonly localStart: number;
    readonly localEnd: number;
    readonly scanStart: number;
    readonly scanEnd: number;
    readonly checked: number;
    readonly failures: readonly string[];
}
/**
 * Exhaustive short-domain verification of localIntervalToUtc: scans every UTC
 * second in the segments' span plus `padding` on both sides and asserts
 *   u in preimage  <=>  localStart <= utcToLocal(u) < localEnd.
 * Also asserts the segments are sorted, half-open and non-overlapping.
 */
export declare function verifyInverseImage(table: TransitionTable, localStart: number, localEnd: number, padding?: number): InverseImageVerification;
