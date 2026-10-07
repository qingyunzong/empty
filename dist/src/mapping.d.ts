import { type TransitionTable } from "./table.js";
export interface UtcToLocalResult {
    readonly utc: number;
    readonly local: number;
    readonly offsetSeconds: number;
    readonly ruleIndex: number;
}
/** Forward map: UTC integer second -> local integer second. Always total. */
export declare function utcToLocal(table: TransitionTable, utc: number): UtcToLocalResult;
export interface UtcCandidate {
    readonly utc: number;
    readonly offsetSeconds: number;
    readonly ruleIndex: number;
}
/**
 * Reverse map result for a local integer second:
 *  - "none":      the local second falls in a gap (offset jumped forward);
 *                 explicitly no solution, candidates is empty.
 *  - "unique":    exactly one UTC second maps to it.
 *  - "ambiguous": the local second falls in an overlap (offset jumped back);
 *                 two candidates for real-world tables, possibly more for
 *                 exotic tables with rapid consecutive transitions.
 */
export interface LocalToUtcResult {
    readonly local: number;
    readonly kind: "none" | "unique" | "ambiguous";
    readonly candidates: readonly UtcCandidate[];
}
/**
 * Reverse map: local integer second -> all UTC seconds that forward-map to it.
 * A UTC second u is a candidate for local L under rule r iff
 * u = L - offset_r and u lies in r's half-open UTC domain.
 */
export declare function localToUtc(table: TransitionTable, local: number): LocalToUtcResult;
export interface RoundTripVerification {
    readonly utcStart: number;
    readonly utcEnd: number;
    readonly checked: number;
    /** UTC seconds whose reverse lookup did not contain the original UTC. */
    readonly failures: readonly number[];
}
/**
 * Exhaustive per-UTC verification over the half-open domain [utcStart, utcEnd):
 * forward-map every UTC second, then confirm the reverse lookup of the
 * resulting local second contains the original UTC second.
 */
export declare function verifyRoundTrip(table: TransitionTable, utcStart: number, utcEnd: number): RoundTripVerification;
