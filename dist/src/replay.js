import { applyAction, isGoal } from './state.js';
/**
 * Replays an action sequence from an initial state, applying every
 * action through the same rules the search uses. Throws on the first
 * illegal action.
 */
export function replayPath(grid, initial, actions) {
    let state = initial;
    for (const action of actions)
        state = applyAction(grid, state, action);
    return state;
}
/**
 * Verifies that an action sequence is legal and reaches the goal.
 * Used to double-check paths produced by the search.
 */
export function verifyPath(grid, initial, actions) {
    try {
        const finalState = replayPath(grid, initial, actions);
        if (!isGoal(grid, finalState)) {
            return { ok: false, finalState, reason: 'path does not reach the goal' };
        }
        return { ok: true, finalState };
    }
    catch (err) {
        const state = safePartial(grid, initial, actions);
        return { ok: false, finalState: state, reason: err.message };
    }
}
function safePartial(grid, initial, actions) {
    let state = initial;
    for (const action of actions) {
        try {
            state = applyAction(grid, state, action);
        }
        catch {
            break;
        }
    }
    return state;
}
