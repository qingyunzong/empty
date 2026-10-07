import { State } from './types.js';
export interface VersionNode {
    readonly id: number;
    readonly state: State;
    readonly parent: number | null;
    readonly branch: string;
}
/**
 * Append-only store of immutable state versions arranged as a tree.
 * Any version can be forked: the fork starts a new branch at the same
 * state, and later commits on either branch diverge without affecting
 * each other.
 */
export declare class StateStore {
    private readonly nodes;
    /** Creates the root version of a new history. */
    create(state: State, branch?: string): number;
    /** Appends a successor state on the same branch as `from`. */
    commit(from: number, state: State): number;
    /** Forks a new branch starting at the same state as `from`. */
    fork(from: number, branch?: string): number;
    state(id: number): State;
    branchOf(id: number): string;
    /** State chain from the root down to `id` (inclusive). */
    history(id: number): State[];
    /** Version ids of all direct children of `id` (commits and forks). */
    children(id: number): number[];
    get size(): number;
    private push;
    private node;
}
