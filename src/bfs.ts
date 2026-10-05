/**
 * Breadth-first search with a serializable frontier.
 *
 * The frontier (FIFO queue) plus the visited set plus the expansion log
 * fully determine the future of the search, so `snapshot()` /
 * `Bfs.restore()` allow pausing and resuming with a visit order
 * identical to an uninterrupted run. Action cost is uniformly 1, so BFS
 * yields shortest plans and closure depths are exact shortest distances.
 */

import {
  Problem,
  SState,
  applyAction,
  initialState,
  isGoal,
  stateKey,
} from "./model.js";

export interface FrontierEntry {
  bits: number;
  res: number[];
  depth: number;
  path: number[]; // action indices from the initial state
}

export interface Snapshot {
  format: "bitplanner-bfs-snapshot-v1";
  stopAtGoal: boolean;
  visited: string[];
  /** Keys of expanded nodes, in expansion order. */
  visitOrder: string[];
  /** Depth of each expanded node, aligned with visitOrder. */
  visitDepths: number[];
  /** Remaining frontier, FIFO order. */
  queue: FrontierEntry[];
  goal: FrontierEntry | null;
}

export interface BfsResult {
  /** Shortest certificate: action indices from initial to goal. */
  plan: number[] | null;
  /** Depth (shortest distance) of the goal, or null if unreachable. */
  goalDepth: number | null;
  /** Reachable closure recorded so far: state key -> shortest depth. */
  closure: Map<string, number>;
  /** State keys in the exact order they were expanded. */
  visitOrder: string[];
}

export class Bfs {
  readonly problem: Problem;
  readonly stopAtGoal: boolean;
  private visited = new Set<string>();
  private queue: FrontierEntry[] = [];
  private head = 0;
  readonly visitOrder: string[] = [];
  readonly visitDepths: number[] = [];
  readonly depthOf = new Map<string, number>();
  private goalEntry: FrontierEntry | null = null;

  constructor(problem: Problem, opts?: { stopAtGoal?: boolean; start?: SState }) {
    this.problem = problem;
    this.stopAtGoal = opts?.stopAtGoal ?? true;
    const s0 = opts?.start ?? initialState(problem);
    this.visited.add(stateKey(s0.bits, s0.res));
    this.queue.push({ bits: s0.bits, res: s0.res, depth: 0, path: [] });
  }

  /** Expand one frontier node. Returns false when the search is done. */
  step(): boolean {
    if (this.done) return false;
    const entry = this.queue[this.head]!;
    this.head++;
    const key = stateKey(entry.bits, entry.res);
    this.visitOrder.push(key);
    this.visitDepths.push(entry.depth);
    this.depthOf.set(key, entry.depth);
    if (this.stopAtGoal && isGoal(this.problem, entry.bits)) {
      this.goalEntry = entry;
      return false;
    }
    const s = { bits: entry.bits, res: entry.res };
    for (const a of this.problem.actions) {
      const next = applyAction(this.problem, s, a);
      if (!next) continue;
      const nkey = stateKey(next.bits, next.res);
      if (this.visited.has(nkey)) continue;
      this.visited.add(nkey);
      this.queue.push({
        bits: next.bits,
        res: next.res,
        depth: entry.depth + 1,
        path: [...entry.path, a.index],
      });
    }
    return true;
  }

  /** Run at most `maxSteps` expansions (default: until done). */
  run(maxSteps = Number.POSITIVE_INFINITY): BfsResult {
    let n = 0;
    while (n < maxSteps && this.step()) n++;
    return this.result();
  }

  get done(): boolean {
    return this.goalEntry !== null || this.head >= this.queue.length;
  }

  result(): BfsResult {
    return {
      plan: this.goalEntry ? [...this.goalEntry.path] : null,
      goalDepth: this.goalEntry ? this.goalEntry.depth : null,
      closure: new Map(this.depthOf),
      visitOrder: [...this.visitOrder],
    };
  }

  /** Serialize the exact search state to a JSON-friendly object. */
  snapshot(): Snapshot {
    const clone = (e: FrontierEntry): FrontierEntry => ({
      bits: e.bits,
      res: [...e.res],
      depth: e.depth,
      path: [...e.path],
    });
    return {
      format: "bitplanner-bfs-snapshot-v1",
      stopAtGoal: this.stopAtGoal,
      visited: [...this.visited],
      visitOrder: [...this.visitOrder],
      visitDepths: [...this.visitDepths],
      queue: this.queue.slice(this.head).map(clone),
      goal: this.goalEntry ? clone(this.goalEntry) : null,
    };
  }

  snapshotJson(): string {
    return JSON.stringify(this.snapshot());
  }

  /** Restore a paused search; continuing yields the same visit order. */
  static restore(problem: Problem, snap: Snapshot): Bfs {
    if (snap.format !== "bitplanner-bfs-snapshot-v1") {
      throw new Error(`unknown snapshot format: ${(snap as Snapshot).format}`);
    }
    if (snap.visitOrder.length !== snap.visitDepths.length) {
      throw new Error("corrupt snapshot: visitOrder/visitDepths length mismatch");
    }
    const b = new Bfs(problem, { stopAtGoal: snap.stopAtGoal });
    b.visited = new Set(snap.visited);
    b.visitOrder.push(...snap.visitOrder);
    b.visitDepths.push(...snap.visitDepths);
    for (let i = 0; i < snap.visitOrder.length; i++) {
      b.depthOf.set(snap.visitOrder[i]!, snap.visitDepths[i]!);
    }
    b.queue = snap.queue.map((e) => ({ ...e, res: [...e.res], path: [...e.path] }));
    b.head = 0;
    b.goalEntry = snap.goal
      ? { ...snap.goal, res: [...snap.goal.res], path: [...snap.goal.path] }
      : null;
    return b;
  }
}

/** Convenience: shortest plan (certificate) or null when unreachable. */
export function shortestPlan(problem: Problem): BfsResult {
  return new Bfs(problem).run();
}

/** Convenience: full reachable closure with exact shortest depths. */
export function reachableClosure(problem: Problem): Map<string, number> {
  const b = new Bfs(problem, { stopAtGoal: false });
  while (b.step()) {
    // exhaust the frontier
  }
  return b.depthOf;
}
