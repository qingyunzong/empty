export interface ConstraintEdge {
    from: string;
    to: string;
    /** from - to = diff */
    diff: bigint;
}
export type QueryResult = {
    kind: 'known';
    diff: bigint;
} | {
    kind: 'unknown';
};
export type AddResult = {
    ok: true;
} | {
    ok: false;
    reason: 'contradiction';
    /** difference x - y implied by the constraints already stored */
    implied: bigint;
    /**
     * Cycle of edges proving the conflict: every stored path edge
     * (x ~~> y, telescoping to `implied`) followed by the rejected
     * constraint traversed backwards (y -> x, diff = -d).
     * The diffs sum to `implied - d`, which is non-zero.
     */
    evidence: ConstraintEdge[];
};
/**
 * Difference-constraint store over string variable aliases.
 *
 * Records constraints of the form `x - y = d` (bigint arithmetic) in a
 * weighted union-find without path compression, which keeps parent chains
 * intact so unions can be undone: `snapshot()` returns an opaque handle and
 * `rollback(handle)` restores the exact prior state.
 *
 * `query(x, y)` returns the implied difference, or `unknown` when the two
 * variables live in disconnected components (or were never constrained).
 * A contradicting `add` is rejected, leaves the store untouched, and
 * returns the evidence cycle that proves the conflict.
 */
export declare class DifferenceConstraints {
    private parent;
    /** weight[x] = x - parent[x] */
    private weight;
    private size;
    private history;
    private ensure;
    /** Root of x plus its potential: x - root. */
    private find;
    has(x: string): boolean;
    /** Record `x - y = diff`. Rejects contradictions without mutating state. */
    add(x: string, y: string, diff: bigint): AddResult;
    query(x: string, y: string): QueryResult;
    /**
     * Opaque handle to the current state; pass to `rollback` later.
     * Rolling back past a snapshot invalidates its handle.
     */
    snapshot(): number;
    /** Undo every union recorded after `snap` was taken. */
    rollback(snap: number): void;
    /** Edges (cur, parent, cur - parent) from x up to its root. */
    private chainToRoot;
    private evidenceCycle;
}
