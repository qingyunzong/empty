import { type JsonValue } from "./json.js";
import { type Resolution, type StaleReason } from "./resolution.js";
import { type DiffOp } from "./diff.js";
export type ConflictStatus = "pending" | "reopened";
/** Full provenance for one conflicting field. */
export interface ConflictInfo {
    path: string[];
    displayPath: string;
    status: ConflictStatus;
    /** Source values at the conflicted path (undefined = absent on that side). */
    base: JsonValue | undefined;
    ours: JsonValue | undefined;
    theirs: JsonValue | undefined;
    baseDigest: string;
    oursDigest: string;
    theirsDigest: string;
    /** Which sides diverged from base: "both", "ours-only", "theirs-only". */
    origin: "both";
    /** Present when status === "reopened": the stale resolution that no longer matches. */
    staleResolution?: Resolution;
    staleReason?: StaleReason;
}
export interface AppliedResolution {
    path: string[];
    displayPath: string;
    resolution: Resolution;
    value: JsonValue | undefined;
}
export interface MergeResult {
    merged: JsonValue;
    /** Unresolved conflicts: never-resolved ("pending") plus stale ("reopened"). */
    conflicts: ConflictInfo[];
    /** Resolutions whose bound digests still matched and were applied. */
    applied: AppliedResolution[];
    /** Final diff from base to merged. */
    diff: DiffOp[];
    /** True when every conflict was resolved. */
    clean: boolean;
}
export interface MergeInput {
    base: JsonValue;
    ours: JsonValue;
    theirs: JsonValue;
    resolutions?: Resolution[];
}
export declare function merge3(input: MergeInput): MergeResult;
