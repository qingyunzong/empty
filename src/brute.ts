import { Engine, GameState } from './engine.js';
import { combine, betterOf, EMPTY_RESULT, SearchResult } from './solver.js';

export interface StateSpaceReport {
  states: number;
  /** max captures = initial enemies - min enemies over all reachable states */
  maxCaptures: number;
  minEnemies: number;
}

/**
 * Independent cross-check #1: plain BFS over the full reachable state space.
 * Captures only depend on removed enemies, so the optimum equals
 * initialEnemies - min reachable enemy count.
 */
export function bfsStateSpace(engine: Engine, maxStates = 5_000_000): StateSpaceReport {
  const start = engine.initialState();
  const seen = new Set<string>([engine.key(start)]);
  let frontier: GameState[] = [start];
  let minEnemies = engine.popcountEnemies(start);
  while (frontier.length > 0) {
    const next: GameState[] = [];
    for (const s of frontier) {
      for (const m of engine.genMoves(s)) {
        const ns = engine.apply(s, m);
        const k = engine.key(ns);
        if (seen.has(k)) continue;
        seen.add(k);
        const e = engine.popcountEnemies(ns);
        if (e < minEnemies) minEnemies = e;
        next.push(ns);
      }
      if (seen.size > maxStates) {
        throw new Error(`state space exceeds limit of ${maxStates}`);
      }
    }
    frontier = next;
  }
  return {
    states: seen.size,
    maxCaptures: engine.enemyCells.length - minEnemies,
    minEnemies,
  };
}

export interface ExhaustiveReport {
  result: SearchResult;
  /** number of DFS node visits (no memoization) */
  visits: number;
}

/**
 * Independent cross-check #2: exhaustive DFS without memoization over
 * cycle-free move sequences. Only feasible for small boards; throws when
 * the visit budget is exceeded.
 */
export function exhaustiveSearch(engine: Engine, maxVisits = 2_000_000): ExhaustiveReport {
  let visits = 0;
  const path = new Set<string>();
  const dfs = (s: GameState): SearchResult => {
    visits++;
    if (visits > maxVisits) throw new Error(`exhaustive search exceeds visit limit of ${maxVisits}`);
    let best = EMPTY_RESULT;
    for (const m of engine.genMoves(s)) {
      const ns = engine.apply(s, m);
      const k = engine.key(ns);
      if (path.has(k)) continue;
      path.add(k);
      const sub = dfs(ns);
      path.delete(k);
      best = betterOf(best, combine(m, sub));
    }
    return best;
  };
  const start = engine.initialState();
  path.add(engine.key(start));
  const result = dfs(start);
  return { result, visits };
}
