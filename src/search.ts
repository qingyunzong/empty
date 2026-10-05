import { HeapEntry, MinHeap } from "./heap";

/** A single outgoing edge of the state graph. */
export interface Successor<S> {
  state: S;
  cost: number;
}

/**
 * A finite state graph search problem. All functions must be pure and
 * deterministic: `successors` must always return edges in the same order
 * for the same state.
 */
export interface Problem<S> {
  start: S;
  isGoal(state: S): boolean;
  successors(state: S): Array<Successor<S>>;
  /** Unique, stable dedup key for a state. */
  key(state: S): string;
  /** Heuristic estimate of remaining cost; priority is f = g + h. */
  heuristic(state: S): number;
}

interface OpenItem<S> {
  key: string;
  state: S;
  g: number;
}

/** Best candidate seen so far: the expanded state closest to the goal. */
export interface BestCandidate<S> {
  key: string;
  state: S;
  h: number;
  f: number;
}

/**
 * Complete, JSON-serializable search state. Contains everything needed
 * to resume with output identical to an uninterrupted run:
 *  - `open`:   the priority queue (raw heap array, exact order preserved)
 *  - `bestG`:  the dedup set (best known g-cost per state key)
 *  - `nextSeq`: the deterministic tie-break counter
 *  - `expanded` / `visits`: progress so far (visit count and order)
 *  - `best`:   best candidate so far
 */
export interface Snapshot<S> {
  open: Array<HeapEntry<OpenItem<S>>>;
  bestG: Record<string, number>;
  nextSeq: number;
  expanded: number;
  visits: Array<string>;
  best: BestCandidate<S> | null;
}

/** One live entry of the frontier, in the order it would be expanded. */
export interface FrontierEntry {
  key: string;
  g: number;
  f: number;
  seq: number;
}

export type Outcome<S> =
  | { status: "goal"; state: S; cost: number }
  | { status: "exhausted"; snapshot: Snapshot<S> }
  | {
      status: "budget-exhausted";
      frontier: Array<FrontierEntry>;
      snapshot: Snapshot<S>;
    }
  | { status: "cancelled"; snapshot: Snapshot<S> };

export interface RunResult<S> {
  outcome: Outcome<S>;
  /** Total states expanded so far, including previous resumed slices. */
  expanded: number;
  /** Keys of expanded states, in expansion order. */
  visits: Array<string>;
  /** Best candidate among expanded states (min h, then min f, then earliest). */
  best: BestCandidate<S> | null;
}

export interface RunOptions<S> {
  /** Max total expansions (cumulative across resumes). Omit for unlimited. */
  budget?: number;
  /** Cancel and return a snapshot after this many expansions in this call. */
  cancelAfter?: number;
  /** Resume from a previous snapshot instead of starting fresh. */
  snapshot?: Snapshot<S>;
}

function liveFrontier<S>(
  open: Array<HeapEntry<OpenItem<S>>>,
  bestG: Record<string, number>,
): Array<FrontierEntry> {
  return open
    .filter((e) => e.value.g <= (bestG[e.value.key] ?? Infinity))
    .map((e) => ({ key: e.value.key, g: e.value.g, f: e.priority, seq: e.seq }))
    .sort((a, b) => (a.f !== b.f ? a.f - b.f : a.seq - b.seq));
}

/**
 * Best-first search (A*-style, f = g + h) over a finite state graph.
 *
 * Determinism: the expansion order is fully determined by the problem and
 * the snapshot, because queue ties are broken by a persisted insertion
 * counter. Cancelling and resuming from the returned snapshot — including
 * after a JSON serialize/deserialize round-trip — produces exactly the
 * same visit sequence, visit counts and final result as one
 * uninterrupted run.
 */
export function runSearch<S>(
  problem: Problem<S>,
  options: RunOptions<S> = {},
): RunResult<S> {
  let open: MinHeap<OpenItem<S>>;
  let bestG: Record<string, number>;
  let nextSeq: number;
  let expanded: number;
  let visits: Array<string>;
  let best: BestCandidate<S> | null;

  if (options.snapshot !== undefined) {
    const snap = options.snapshot;
    open = MinHeap.fromArray(snap.open);
    bestG = { ...snap.bestG };
    nextSeq = snap.nextSeq;
    expanded = snap.expanded;
    visits = [...snap.visits];
    best = snap.best === null ? null : { ...snap.best };
  } else {
    const startKey = problem.key(problem.start);
    open = MinHeap.empty<OpenItem<S>>();
    open.push({
      priority: problem.heuristic(problem.start),
      seq: 0,
      value: { key: startKey, state: problem.start, g: 0 },
    });
    bestG = { [startKey]: 0 };
    nextSeq = 1;
    expanded = 0;
    visits = [];
    best = null;
  }

  const takeSnapshot = (): Snapshot<S> => ({
    open: open.toArray(),
    bestG: { ...bestG },
    nextSeq,
    expanded,
    visits: [...visits],
    best: best === null ? null : { ...best },
  });

  let stepsThisCall = 0;

  for (;;) {
    if (options.budget !== undefined && expanded >= options.budget) {
      return {
        outcome: {
          status: "budget-exhausted",
          frontier: liveFrontier(open.toArray(), bestG),
          snapshot: takeSnapshot(),
        },
        expanded,
        visits,
        best,
      };
    }
    if (options.cancelAfter !== undefined && stepsThisCall >= options.cancelAfter) {
      return {
        outcome: { status: "cancelled", snapshot: takeSnapshot() },
        expanded,
        visits,
        best,
      };
    }

    const top = open.pop();
    if (top === undefined) {
      return {
        outcome: { status: "exhausted", snapshot: takeSnapshot() },
        expanded,
        visits,
        best,
      };
    }

    const { key, state, g } = top.value;
    if (g > (bestG[key] ?? Infinity)) continue; // stale queue entry

    expanded += 1;
    stepsThisCall += 1;
    visits.push(key);

    const h = problem.heuristic(state);
    const f = g + h;
    if (
      best === null ||
      h < best.h ||
      (h === best.h && f < best.f)
    ) {
      best = { key, state, h, f };
    }

    if (problem.isGoal(state)) {
      return {
        outcome: { status: "goal", state, cost: g },
        expanded,
        visits,
        best,
      };
    }

    for (const edge of problem.successors(state)) {
      const childKey = problem.key(edge.state);
      const childG = g + edge.cost;
      if (childG < (bestG[childKey] ?? Infinity)) {
        bestG[childKey] = childG;
        open.push({
          priority: childG + problem.heuristic(edge.state),
          seq: nextSeq,
          value: { key: childKey, state: edge.state, g: childG },
        });
        nextSeq += 1;
      }
    }
  }
}
