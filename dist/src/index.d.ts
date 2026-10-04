export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** Sentinel meaning "field is absent" (deleted or never present). */
export declare const ABSENT: unique symbol;
export type Absent = typeof ABSENT;
export type Slot = JsonValue | Absent;
export type Doc = Record<string, JsonValue>;
/** SHA-256 summary of one side's value for a field. */
export declare function digest(slot: Slot): string;
export declare function slotEqual(a: Slot, b: Slot): boolean;
/**
 * A resolution choice bound to the digests of BOTH sides' source values
 * as they were when the choice was made. It stays valid only while both
 * sides still hash to the same summaries.
 */
export interface ResolutionEntry {
    value: Slot;
    leftDigest: string;
    rightDigest: string;
}
/** Per-field resolution choices; each field is carried independently. */
export type ResolutionStore = Record<string, ResolutionEntry>;
export type ConflictCause = "both-modified" | "stale-resolution";
export interface Conflict {
    field: string;
    base: Slot;
    left: Slot;
    right: Slot;
    leftDigest: string;
    rightDigest: string;
    cause: ConflictCause;
    /** The expired choice, present when cause is "stale-resolution". */
    stale?: ResolutionEntry;
}
export type DiffOp = "added" | "removed" | "changed";
export interface DiffEntry {
    field: string;
    op: DiffOp;
    from: Slot;
    to: Slot;
}
export interface MergeResult {
    merged: Doc;
    conflicts: Conflict[];
    /** Fields whose stored choice was reused this round. */
    applied: string[];
    /** Store entries still bound to current sources (stale ones dropped). */
    carriedStore: ResolutionStore;
    /** Final diff from base to merged. */
    diff: DiffEntry[];
}
/** Bind a choice for a conflict to the digests of its current sources. */
export declare function resolve(conflict: Conflict, value: Slot): ResolutionEntry;
export declare function merge(base: Doc, left: Doc, right: Doc, store?: ResolutionStore): MergeResult;
