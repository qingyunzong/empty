/**
 * anchor-patch: content-anchored, atomic patch application.
 *
 * A patch carries the ORIGINAL content (`old`) of the range it modifies and
 * the replacement (`new`). Locations are resolved against the current target
 * text by searching for `old`, so a target that has already drifted from the
 * baseline is still patched correctly as long as the anchored content is
 * present exactly once. Multiple matches are reported as ambiguity and never
 * guessed; all patches are validated before any of them is applied.
 */
/** Needles at or below this length are treated as "small strings": every
 *  repeated occurrence is enumerated with a context excerpt in the evidence
 *  so a human can cross-check the ambiguity report. */
export declare const SMALL_STRING_THRESHOLD = 8;
/** Characters of surrounding context shown in candidate excerpts. */
export declare const EXCERPT_CONTEXT = 24;
export interface Patch {
    /** Optional caller-chosen identifier, echoed in evidence and errors. */
    readonly id?: string;
    /** Original content of the modified range (the location anchor). */
    readonly old: string;
    /** Replacement content. */
    readonly new: string;
    /** Expected offset in the BASELINE, if known. Used as evidence only:
     *  it never disambiguates multiple matches. */
    readonly hint?: number;
}
export type LocateStatus = "unique" | "ambiguous" | "not-found";
export interface Candidate {
    /** Offset of this occurrence in the target text. */
    readonly offset: number;
    /** Target excerpt around the occurrence: `before >>>match<<< after`. */
    readonly excerpt: string;
}
export interface LocateEvidence {
    readonly patchIndex: number;
    readonly id?: string;
    readonly status: LocateStatus;
    /** True when `old.length <= SMALL_STRING_THRESHOLD`. */
    readonly smallString: boolean;
    readonly oldLength: number;
    readonly matchCount: number;
    /** Every occurrence of `old` in the target, enumerated and cross-checked. */
    readonly candidates: readonly Candidate[];
    /** Set only when status is "unique". */
    readonly chosenOffset?: number;
    readonly hint?: number;
    /** Whether the target at `hint` starts with `old`. */
    readonly hintMatched?: boolean;
}
export interface InversePatch {
    readonly id?: string;
    /** Offset in the PATCHED output where the inverse applies. */
    readonly offset: number;
    /** Content to locate when reverting (equals the forward patch's `new`). */
    readonly old: string;
    /** Content to restore when reverting (equals the forward patch's `old`). */
    readonly new: string;
}
export interface ApplySuccess {
    readonly ok: true;
    readonly output: string;
    /** Inverse patches in output coordinates; reverting restores the target. */
    readonly inverse: readonly InversePatch[];
    readonly evidence: readonly LocateEvidence[];
}
export interface ApplyFailure {
    readonly ok: false;
    readonly errors: readonly string[];
    readonly evidence: readonly LocateEvidence[];
}
export type ApplyResult = ApplySuccess | ApplyFailure;
/** Enumerate ALL occurrences of `needle` in `haystack`, including
 *  overlapping ones, so repeated small strings are fully cross-checked. */
export declare function enumerateOccurrences(haystack: string, needle: string): number[];
/** Locate one patch against the target. Never guesses: a unique match is
 *  required; zero matches is "not-found", more than one is "ambiguous". */
export declare function locate(target: string, patch: Patch, patchIndex?: number): LocateEvidence;
/**
 * Validate every patch against the target, then apply all of them
 * atomically. If any patch fails to locate uniquely, or two located ranges
 * overlap, nothing is applied and the failure carries the full evidence.
 */
export declare function applyPatches(target: string, patches: readonly Patch[]): ApplyResult;
/** Revert a previously applied result: applies the inverse patches through
 *  the same atomic machinery, restoring the original target. */
export declare function revert(output: string, inverse: readonly InversePatch[]): ApplyResult;
