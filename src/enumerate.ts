import { Board } from "./board.ts";
import { applyAction, generateActions } from "./moves.ts";
import { compareLandings, LimitExceededError } from "./search.ts";
import { stateKey } from "./state.ts";
import type { Action, BestLine, State, Vec } from "./types.ts";

export interface EnumerationResult {
  stateCount: number;
  maxCaptures: number;
}

export function enumerateAll(board: Board, nodeLimit = 2_000_000): EnumerationResult {
  const initial = board.initialState();
  const seen = new Set<string>([stateKey(initial)]);
  const queue: State[] = [initial];
  let maxCaptures = 0;
  while (queue.length > 0) {
    const state = queue.shift() as State;
    if (seen.size > nodeLimit) throw new LimitExceededError(nodeLimit);
    maxCaptures = Math.max(maxCaptures, board.totalEnemies - state.enemies.length);
    for (const a of generateActions(board, state)) {
      const next = applyAction(board, state, a);
      const k = stateKey(next);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(next);
      }
    }
  }
  return { stateCount: seen.size, maxCaptures };
}

export interface BruteForceResult extends BestLine {
  nodes: number;
}

export function bruteForce(board: Board, nodeLimit = 500_000): BruteForceResult {
  let best: BestLine = { captures: 0, landings: [], actions: [] };
  let nodes = 0;
  const initial = board.initialState();

  const visit = (state: State, path: Action[], landings: Vec[], onPath: Set<string>): void => {
    nodes += 1;
    if (nodes > nodeLimit) throw new LimitExceededError(nodeLimit);
    if (
      landings.length > best.captures ||
      (landings.length === best.captures &&
        compareLandings(landings, best.landings) < 0)
    ) {
      best = { captures: landings.length, landings: [...landings], actions: [...path] };
    }
    for (const a of generateActions(board, state)) {
      const next = applyAction(board, state, a);
      const k = stateKey(next);
      if (onPath.has(k)) continue;
      onPath.add(k);
      visit(next, [...path, a], a.kind === "jump" ? [...landings, a.to] : landings, onPath);
      onPath.delete(k);
    }
  };

  visit(initial, [], [], new Set([stateKey(initial)]));
  return { ...best, nodes };
}
