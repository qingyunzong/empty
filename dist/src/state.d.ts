import { Action, Direction, Grid, State } from './types.js';
export declare const DIRECTIONS: readonly Direction[];
/** Bitmask of keys spent on currently open doors. */
export declare function spentKeys(grid: Grid, state: State): number;
/** Bitmask of keys currently held (collected and not spent on an open door). */
export declare function heldKeys(grid: Grid, state: State): number;
export declare function isGoal(grid: Grid, state: State): boolean;
/**
 * Applies an action to a state, returning the new immutable state.
 * Throws on any illegal action (wall, closed door, missing key, ...).
 * - move: walks one cell; entering a key cell collects it; closed doors block.
 * - open: opens an adjacent closed door, consuming the matching held key.
 * - undo-open: closes an adjacent open door, refunding the consumed key.
 */
export declare function applyAction(grid: Grid, state: State, action: Action): State;
/** All currently legal actions, in deterministic order. */
export declare function legalActions(grid: Grid, state: State): Action[];
/** Canonical key for a full state, used by the BFS visited set. */
export declare function stateKey(state: State): string;
