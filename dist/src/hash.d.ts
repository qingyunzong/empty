/**
 * Compute a deterministic content hash over a set of named files.
 * The hash binds BOTH the file paths and the exact file contents:
 * any change to any file (or the file set) yields a different hash.
 */
export declare function hashSourceFiles(files: ReadonlyMap<string, string> | Record<string, string>): string;
/** Recursively list files under dir (relative posix-style paths, sorted). */
export declare function listFilesRecursive(dir: string): string[];
/** Read a directory tree into a path->content map. */
export declare function readSourceTree(dir: string): Map<string, string>;
/** Hash the current on-disk source tree. */
export declare function hashSourceTree(dir: string): string;
/**
 * Verify that the on-disk tree still matches an expected hash.
 * Returns the actual hash and, on mismatch, the list of changed paths
 * (added / removed / modified) relative to the recorded snapshot, when
 * the snapshot contents are provided.
 */
export declare function verifySourceTree(dir: string, expectedHash: string, snapshot?: ReadonlyMap<string, string>): {
    ok: boolean;
    actualHash: string;
    changedPaths: string[];
};
