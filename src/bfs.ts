import { verifyPath } from './replay.js';
import { applyAction, isGoal, legalActions, stateKey } from './state.js';
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
export function shortestPath(
  grid: Grid,
  initial: State,
  maxExplored = 1_000_000,
): SearchResult | null {
  if (isGoal(grid, initial)) {
    return { actions: [], finalState: initial, explored: 0, verified: true };
  }

  interface Node {
    state: State;
    parent: number; // index into nodes, -1 for root
    action: Action | null;
  }

  const nodes: Node[] = [{ state: initial, parent: -1, action: null }];
  const visited = new Set<string>([stateKey(initial)]);
  let head = 0;
  let explored = 0;

  while (head < nodes.length) {
    const node = nodes[head++]!;
    if (explored++ > maxExplored) {
      throw new Error(`search aborted after expanding ${maxExplored} states`);
    }
    for (const action of legalActions(grid, node.state)) {
      const next = applyAction(grid, node.state, action);
      const key = stateKey(next);
      if (visited.has(key)) continue;
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

function reconstruct(nodes: { parent: number; action: Action | null }[], goalIdx: number): Action[] {
  const actions: Action[] = [];
  let cur = goalIdx;
  while (nodes[cur]!.parent !== -1) {
    actions.push(nodes[cur]!.action!);
    cur = nodes[cur]!.parent;
  }
  return actions.reverse();
}
