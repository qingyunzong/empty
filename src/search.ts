import { Board } from "./board.ts";
import { applyAction, generateActions } from "./moves.ts";
import { cmpVec, stateKey } from "./state.ts";
import type { Action, BestLine, State, Vec } from "./types.ts";

export class LimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`state limit ${limit} exceeded`);
    this.limit = limit;
  }
}

export interface SolveResult extends BestLine {
  statesExplored: number;
  proved: boolean;
}

export function compareLandings(a: Vec[], b: Vec[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const c = cmpVec(a[i] as Vec, b[i] as Vec);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

interface ClosureNode {
  state: State;
  prev: string | null;
  via: Action | null;
}

export class Solver {
  readonly memo: Map<string, BestLine>;
  readonly board: Board;
  explored = 0;
  private readonly maxStates: number;

  constructor(
    board: Board,
    opts: { maxStates?: number; memo?: Map<string, BestLine> } = {}
  ) {
    this.board = board;
    this.memo = opts.memo ?? new Map();
    this.maxStates = opts.maxStates ?? Number.POSITIVE_INFINITY;
  }

  solve(): SolveResult {
    const best = this.best(this.board.initialState());
    return { ...best, statesExplored: this.explored, proved: true };
  }

  private best(state: State): BestLine {
    const key = stateKey(state);
    const hit = this.memo.get(key);
    if (hit) return hit;
    this.explored += 1;
    if (this.explored > this.maxStates) throw new LimitExceededError(this.maxStates);

    let best: BestLine = { captures: 0, landings: [], actions: [] };

    const seen = new Map<string, ClosureNode>();
    seen.set(key, { state, prev: null, via: null });
    const queue: string[] = [key];
    while (queue.length > 0) {
      const k = queue.shift() as string;
      const node = seen.get(k) as ClosureNode;
      for (const a of generateActions(this.board, node.state)) {
        const next = applyAction(this.board, node.state, a);
        if (a.kind === "jump") {
          const sub = this.best(next);
          const cand: BestLine = {
            captures: 1 + sub.captures,
            landings: [a.to, ...sub.landings],
            actions: [...pathTo(seen, k), a, ...sub.actions],
          };
          if (
            cand.captures > best.captures ||
            (cand.captures === best.captures &&
              compareLandings(cand.landings, best.landings) < 0)
          ) {
            best = cand;
          }
        } else {
          const nk = stateKey(next);
          if (!seen.has(nk)) {
            seen.set(nk, { state: next, prev: k, via: a });
            queue.push(nk);
          }
        }
      }
    }
    this.memo.set(key, best);
    return best;
  }
}

function pathTo(seen: Map<string, ClosureNode>, k: string): Action[] {
  const out: Action[] = [];
  let cur: string | null = k;
  while (cur !== null) {
    const node = seen.get(cur) as ClosureNode;
    if (node.via !== null) out.unshift(node.via);
    cur = node.prev;
  }
  return out;
}

export function staticUpperBound(board: Board, state: State): number {
  const dirs = [...board.dirs[0], ...board.dirs[1]];
  let capturable = 0;
  for (const e of state.enemies) {
    const possible = dirs.some((d) => {
      const from: Vec = [e[0] - d[0], e[1] - d[1]];
      const land: Vec = [e[0] + d[0], e[1] + d[1]];
      return board.standable(from) && board.standable(land);
    });
    if (possible) capturable += 1;
  }
  return board.totalEnemies - state.enemies.length + capturable;
}
