import { Engine, GameState, Move } from './engine.js';
import { Puzzle } from './model.js';

/**
 * Objective ordering (total order, DP-compatible):
 *  1. more captures wins;
 *  2. tie -> lexicographically smaller jump-landing sequence wins
 *     (landing cells compared by cell index y*width+x; a prefix is smaller);
 *  3. tie -> fewer total moves wins (also guarantees finiteness: any cycle
 *     is capture-free, so dropping it strictly improves criterion 3, which
 *     makes skipping on-path states during DFS sound).
 */
export interface SearchResult {
  captures: number;
  /** landing cells of jumps only, in order */
  jumpSeq: number[];
  /** full move list */
  moves: Move[];
}

export const EMPTY_RESULT: SearchResult = { captures: 0, jumpSeq: [], moves: [] };

function compareJumpSeq(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** true iff a is strictly better than b */
export function isBetter(a: SearchResult, b: SearchResult): boolean {
  if (a.captures !== b.captures) return a.captures > b.captures;
  const c = compareJumpSeq(a.jumpSeq, b.jumpSeq);
  if (c !== 0) return c < 0;
  return a.moves.length < b.moves.length;
}

export function betterOf(a: SearchResult, b: SearchResult): SearchResult {
  return isBetter(a, b) ? a : b;
}

export function combine(move: Move, sub: SearchResult): SearchResult {
  const isJump = move.kind === 'jump';
  return {
    captures: sub.captures + (isJump ? 1 : 0),
    jumpSeq: isJump ? [move.to, ...sub.jumpSeq] : sub.jumpSeq,
    moves: [move, ...sub.moves],
  };
}

interface Frame {
  key: string;
  state: GameState;
  moves: Move[];
  next: number;
  best: SearchResult;
  /** move that led from the parent frame to this one (null for root) */
  via: Move | null;
}

export interface SolverStats {
  pops: number;
  memoHits: number;
  cycleSkips: number;
  maxDepth: number;
}

/** Serializable checkpoint: full search state, restorable across processes. */
export interface Checkpoint {
  version: 1;
  puzzle: Puzzle;
  memo: [string, SearchResult][];
  stack: {
    key: string;
    state: GameState;
    next: number;
    best: SearchResult;
    via: Move | null;
  }[];
  stats: SolverStats;
  done: boolean;
  result: SearchResult | null;
}

export class Solver {
  memo = new Map<string, SearchResult>();
  private stack: Frame[] = [];
  private path = new Set<string>();
  stats: SolverStats = { pops: 0, memoHits: 0, cycleSkips: 0, maxDepth: 0 };
  result: SearchResult | null = null;

  constructor(readonly engine: Engine) {
    const s = engine.initialState();
    const key = engine.key(s);
    this.stack.push({ key, state: s, moves: engine.genMoves(s), next: 0, best: EMPTY_RESULT, via: null });
    this.path.add(key);
  }

  get pending(): boolean {
    return this.result === null;
  }

  /**
   * Run until done or until `maxPops` frames have been finalized in this
   * call. Returns the result, or null if paused (call run() again to
   * continue, possibly after a checkpoint round-trip).
   */
  run(maxPops = Infinity, onProgress?: (s: Solver) => void, progressEvery = 0): SearchResult | null {
    if (this.result !== null) return this.result;
    const eng = this.engine;
    const popBudget = this.stats.pops + maxPops;
    while (this.stack.length > 0) {
      if (this.stats.pops >= popBudget) return null;
      if (progressEvery > 0 && onProgress && this.stats.pops % progressEvery === 0) onProgress(this);
      const top = this.stack[this.stack.length - 1]!;
      if (top.next < top.moves.length) {
        const move = top.moves[top.next++]!;
        const child = eng.apply(top.state, move);
        const ckey = eng.key(child);
        if (this.path.has(ckey)) {
          this.stats.cycleSkips++;
          continue;
        }
        const memoized = this.memo.get(ckey);
        if (memoized !== undefined) {
          top.best = betterOf(top.best, combine(move, memoized));
          this.stats.memoHits++;
          continue;
        }
        this.stack.push({ key: ckey, state: child, moves: eng.genMoves(child), next: 0, best: EMPTY_RESULT, via: move });
        this.path.add(ckey);
        if (this.stack.length > this.stats.maxDepth) this.stats.maxDepth = this.stack.length;
      } else {
        this.memo.set(top.key, top.best);
        this.stats.pops++;
        this.stack.pop();
        this.path.delete(top.key);
        const parent = this.stack[this.stack.length - 1];
        if (parent !== undefined) {
          parent.best = betterOf(parent.best, combine(top.via!, top.best));
        } else {
          this.result = top.best;
        }
      }
    }
    return this.result;
  }

  toCheckpoint(): Checkpoint {
    return {
      version: 1,
      puzzle: this.engine.puzzle,
      memo: [...this.memo.entries()],
      stack: this.stack.map((f) => ({ key: f.key, state: f.state, next: f.next, best: f.best, via: f.via })),
      stats: { ...this.stats },
      done: this.result !== null,
      result: this.result,
    };
  }

  static fromCheckpoint(cp: Checkpoint): Solver {
    if (cp.version !== 1) throw new Error(`unsupported checkpoint version ${cp.version}`);
    const engine = new Engine(cp.puzzle);
    const solver = Object.create(Solver.prototype) as Solver;
    (solver as { engine: Engine }).engine = engine;
    solver.memo = new Map(cp.memo);
    solver.stats = { ...cp.stats };
    solver.result = cp.result;
    solver.path = new Set<string>();
    solver.stack = cp.stack.map((f) => {
      solver.path!.add(f.key);
      return { key: f.key, state: f.state, moves: engine.genMoves(f.state), next: f.next, best: f.best, via: f.via };
    });
    if (!cp.done && solver.stack.length === 0) {
      throw new Error('corrupt checkpoint: not done but search stack is empty');
    }
    return solver;
  }
}
