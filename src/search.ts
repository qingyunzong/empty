import { MinHeap, HeapSnapshot } from "./heap";

/**
 * A finite state graph. Iteration order of start()/neighbors() must be
 * deterministic; combined with the heap's sequence numbers this makes the
 * whole search deterministic. States must be JSON-serializable so that
 * snapshots can be persisted.
 */
export interface Graph<S> {
  start(): Iterable<S>;
  neighbors(state: S): Iterable<S>;
  key(state: S): string;
  /** Lower priority is expanded first. Defaults to 0. */
  priority?(state: S): number;
  /** Higher score is a better candidate. Defaults to 0. */
  score?(state: S): number;
}

export type SearchStatus = "running" | "complete" | "budget-exhausted" | "cancelled";

export interface BestEntry {
  key: string;
  score: number;
  visitIndex: number;
}

interface OpenEntry<S> {
  key: string;
  state: S;
}

/** JSON-serializable snapshot of everything needed to resume a search. */
export interface Snapshot<S = unknown> {
  version: 1;
  status: SearchStatus;
  /** Dedup set, in insertion (discovery) order. */
  seen: string[];
  /** Priority queue including per-entry sequence numbers. */
  heap: HeapSnapshot<OpenEntry<S>>;
  visits: number;
  visitOrder: string[];
  best: BestEntry[];
  /** null represents an unlimited budget. */
  budgetRemaining: number | null;
  bestK: number;
}

export interface SearchResult {
  status: SearchStatus;
  visits: number;
  visitOrder: string[];
  /** Remaining open list, in the order it would be expanded. */
  frontier: string[];
  best: BestEntry[];
}

export interface SearchOptions {
  /** Maximum number of node expansions. Defaults to unlimited. */
  budget?: number;
  /** How many best candidates to track. Defaults to 10. */
  bestK?: number;
}

export interface ResumeOptions {
  /** Extra expansions granted on top of the snapshotted remaining budget. */
  additionalBudget?: number;
}

export class Search<S> {
  private readonly graph: Graph<S>;
  private heap: MinHeap<OpenEntry<S>>;
  private readonly seen: Set<string>;
  private readonly bestK: number;
  private budgetRemaining: number;
  private cancelRequested = false;

  private statusValue: SearchStatus = "running";
  private visitsValue = 0;
  private visitOrderValue: string[] = [];
  private bestValue: BestEntry[] = [];

  private constructor(graph: Graph<S>, bestK: number, budget: number) {
    this.graph = graph;
    this.heap = new MinHeap<OpenEntry<S>>();
    this.seen = new Set<string>();
    this.bestK = bestK;
    this.budgetRemaining = budget;
  }

  static start<S>(graph: Graph<S>, options: SearchOptions = {}): Search<S> {
    const search = new Search<S>(graph, options.bestK ?? 10, options.budget ?? Infinity);
    for (const state of graph.start()) search.offer(state);
    return search;
  }

  /** Rebuild a search from a snapshot (e.g. after JSON round-trip). */
  static resume<S>(graph: Graph<S>, snapshot: Snapshot<S>, options: ResumeOptions = {}): Search<S> {
    const budget = snapshot.budgetRemaining === null ? Infinity : snapshot.budgetRemaining;
    const search = new Search<S>(graph, snapshot.bestK, budget + (options.additionalBudget ?? 0));
    search.heap = new MinHeap<OpenEntry<S>>(snapshot.heap);
    for (const key of snapshot.seen) search.seen.add(key);
    search.visitsValue = snapshot.visits;
    search.visitOrderValue = [...snapshot.visitOrder];
    search.bestValue = snapshot.best.map((b) => ({ ...b }));
    // The status is restored exactly; "cancelled" and "budget-exhausted"
    // are pause states that step() resumes from automatically.
    search.statusValue = snapshot.status;
    return search;
  }

  get status(): SearchStatus {
    return this.statusValue;
  }

  get visits(): number {
    return this.visitsValue;
  }

  get visitOrder(): readonly string[] {
    return this.visitOrderValue;
  }

  get best(): readonly BestEntry[] {
    return this.bestValue;
  }

  get frontierSize(): number {
    return this.heap.size;
  }

  /** Ask the search to pause at the next expansion boundary. */
  cancel(): void {
    this.cancelRequested = true;
  }

  /** Grant more expansions to a budget-exhausted search. */
  addBudget(extra: number): void {
    this.budgetRemaining += extra;
    if (this.statusValue === "budget-exhausted") this.statusValue = "running";
  }

  /**
   * Expand a single node. Returns false when the search makes no progress
   * this call (complete, budget exhausted, or cancelled). Cancelled and
   * budget-exhausted searches continue once stepped again with budget left.
   */
  step(): boolean {
    if (this.statusValue === "complete") return false;
    if (this.heap.size === 0) {
      this.statusValue = "complete";
      return false;
    }
    if (this.cancelRequested) {
      this.statusValue = "cancelled";
      return false;
    }
    if (this.budgetRemaining <= 0) {
      this.statusValue = "budget-exhausted";
      return false;
    }
    const entry = this.heap.pop()!;
    this.statusValue = "running";
    this.budgetRemaining -= 1;
    this.visitsValue += 1;
    this.visitOrderValue.push(entry.key);
    this.recordBest(entry.key, this.graph.score?.(entry.state) ?? 0);
    for (const next of this.graph.neighbors(entry.state)) this.offer(next);
    return true;
  }

  /** Expand nodes until the search terminates for any reason. */
  run(): SearchResult {
    while (this.step()) {
      // expand one node per iteration
    }
    return this.result();
  }

  result(): SearchResult {
    return {
      status: this.statusValue,
      visits: this.visitsValue,
      visitOrder: [...this.visitOrderValue],
      frontier: this.heap.drainSorted().map((e) => e.key),
      best: this.bestValue.map((b) => ({ ...b })),
    };
  }

  snapshot(): Snapshot<S> {
    return {
      version: 1,
      status: this.statusValue,
      seen: [...this.seen],
      heap: this.heap.snapshot(),
      visits: this.visitsValue,
      visitOrder: [...this.visitOrderValue],
      best: this.bestValue.map((b) => ({ ...b })),
      budgetRemaining: this.budgetRemaining === Infinity ? null : this.budgetRemaining,
      bestK: this.bestK,
    };
  }

  private offer(state: S): void {
    const key = this.graph.key(state);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.heap.push(this.graph.priority?.(state) ?? 0, { key, state });
  }

  private recordBest(key: string, score: number): void {
    const entry: BestEntry = { key, score, visitIndex: this.visitsValue };
    // Keep bestValue sorted by (score desc, visitIndex asc), truncated to bestK.
    let insertAt = this.bestValue.length;
    for (let i = 0; i < this.bestValue.length; i++) {
      const cur = this.bestValue[i]!;
      if (score > cur.score || (score === cur.score && entry.visitIndex < cur.visitIndex)) {
        insertAt = i;
        break;
      }
    }
    this.bestValue.splice(insertAt, 0, entry);
    if (this.bestValue.length > this.bestK) this.bestValue.length = this.bestK;
  }
}
