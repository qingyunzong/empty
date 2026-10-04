import { type JsonValue } from "./json.js";
/** Which side's value a resolution picks, or an explicit custom value. */
export type Choice = {
    kind: "ours";
} | {
    kind: "theirs";
} | {
    kind: "base";
} | {
    kind: "custom";
    value: JsonValue;
};
/**
 * A resolution choice bound to the digests of BOTH sides' source values
 * (and the base value, for provenance) at the moment it was made.
 * It stays valid only while the sources at `path` still match those digests.
 */
export interface Resolution {
    /** Field path the conflict is at, e.g. ["profile", "name"]. */
    path: string[];
    choice: Choice;
    baseDigest: string;
    oursDigest: string;
    theirsDigest: string;
}
export type StaleReason = "ours-changed" | "theirs-changed" | "both-changed";
/**
 * Bind a choice for `path` to the current sources. Digests are taken from
 * the values at `path` in base/ours/theirs right now.
 */
export declare function makeResolution(path: string[], choice: Choice, sources: {
    base: JsonValue;
    ours: JsonValue;
    theirs: JsonValue;
}): Resolution;
export interface MatchResult {
    matches: boolean;
    staleReason?: StaleReason;
}
/**
 * Check a stored resolution against the current sources. It matches only if
 * BOTH sides' values at the path still hash to the bound digests.
 */
export declare function matchResolution(res: Resolution, sources: {
    ours: JsonValue;
    theirs: JsonValue;
}): MatchResult;
/** Resolve the choice to a concrete value given the current sources. */
export declare function pickValue(choice: Choice, sources: {
    base: JsonValue;
    ours: JsonValue;
    theirs: JsonValue;
}, path: string[]): JsonValue;
/** Index resolutions by field path; later entries win on duplicates. */
export declare function indexResolutions(resolutions: Resolution[]): Map<string, Resolution>;
