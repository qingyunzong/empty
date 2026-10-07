import { Action, Grid, State } from './types.js';
/**
 * Replays an action sequence from an initial state, applying every
 * action through the same rules the search uses. Throws on the first
 * illegal action.
 */
export declare function replayPath(grid: Grid, initial: State, actions: readonly Action[]): State;
export interface Verification {
    readonly ok: boolean;
    readonly finalState: State;
    readonly reason?: string;
}
/**
 * Verifies that an action sequence is legal and reaches the goal.
 * Used to double-check paths produced by the search.
 */
export declare function verifyPath(grid: Grid, initial: State, actions: readonly Action[]): Verification;
