import { Action, Grid, State } from './types.js';
export interface SearchResult {
    /** Shortest action sequence from the initial state to the goal. */
    readonly actions: Action[];
    /** State reached by the path. */
    readonly finalState: State;
    /** Number of full states expanded during the search. */
    readonly explored: number;
    /** True when the returned path passed an independent replay check. */
    readonly verified: boolean;
}
/**
 * Full-state BFS for the shortest action sequence to the goal.
 * The visited set keys on (position, collected keys, open doors), so
 * undoing a door open to reclaim its key is explored like any other
 * transition. Returns null when the goal is unreachable.
 */
export declare function shortestPath(grid: Grid, initial: State, maxExplored?: number): SearchResult | null;
