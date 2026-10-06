import type { PermissionOp } from '../src/op.js';
/** Deterministic seeded PRNG (mulberry32) so randomized checks are reproducible. */
export declare function mulberry32(seed: number): () => number;
/** Fisher–Yates shuffle driven by the given PRNG. */
export declare function shuffled<T>(items: readonly T[], rng: () => number): T[];
/** Normalize an effective() result into a comparable plain object. */
export declare function normalized(entries: ReadonlyArray<{
    perm: string;
    granted: boolean;
    sources: ReadonlyArray<{
        opId: string;
    }>;
    revokedBy: ReadonlyArray<{
        opId: string;
    }>;
}>): Record<string, {
    granted: boolean;
    sources: string[];
    revokedBy: string[];
}>;
export type { PermissionOp };
