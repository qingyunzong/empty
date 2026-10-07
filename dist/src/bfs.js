import { verifyPath } from './replay.js';
import { applyAction, isGoal, legalActions, stateKey } from './state.js';
/**
 * Full-state BFS for the shortest action sequence to the goal.
 * The visited set keys on (position, collected keys, open doors), so
 * undoing a door open to reclaim its key is explored like any other
 * transition. Returns null when the goal is unreachable.
 */
export function shortestPath(grid, initial, maxExplored = 1_000_000) {
    if (isGoal(grid, initial)) {
        return { actions: [], finalState: initial, explored: 0, verified: true };
    }
    const nodes = [{ state: initial, parent: -1, action: null }];
    const visited = new Set([stateKey(initial)]);
    let head = 0;
    let explored = 0;
    while (head < nodes.length) {
        const node = nodes[head++];
        if (explored++ > maxExplored) {
            throw new Error(`search aborted after expanding ${maxExplored} states`);
        }
        for (const action of legalActions(grid, node.state)) {
            const next = applyAction(grid, node.state, action);
            const key = stateKey(next);
            if (visited.has(key))
                continue;
            visited.add(key);
            nodes.push({ state: next, parent: head - 1, action });
            if (isGoal(grid, next)) {
                const actions = reconstruct(nodes, nodes.length - 1);
                const check = verifyPath(grid, initial, actions);
                if (!check.ok) {
                    throw new Error(`internal error: replay rejected BFS path: ${check.reason}`);
                }
                return { actions, finalState: next, explored, verified: true };
            }
        }
    }
    return null;
}
function reconstruct(nodes, goalIdx) {
    const actions = [];
    let cur = goalIdx;
    while (nodes[cur].parent !== -1) {
        actions.push(nodes[cur].action);
        cur = nodes[cur].parent;
    }
    return actions.reverse();
}
