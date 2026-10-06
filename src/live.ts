import { compile } from "./plan.js";
import type { Plan } from "./plan.js";
import { naiveQuery } from "./naive.js";
import { preorder, isWithin } from "./dom.js";
import type { Document, ElementNode, Mutation } from "./dom.js";

/** An immutable point-in-time result. Old snapshots are never mutated, so
 *  callers may retain them across updates. */
export interface Snapshot {
  readonly version: number;
  /** Matching nodes in document order, deduplicated. */
  readonly matches: readonly ElementNode[];
}

export interface Diff {
  /** Newly matched nodes, in document order. */
  readonly added: readonly ElementNode[];
  /** Newly unmatched nodes, in their previous snapshot order. */
  readonly removed: readonly ElementNode[];
  /** Version of the snapshot this diff produces. */
  readonly version: number;
}

export type LiveCallback = (diff: Diff, snapshot: Snapshot) => void;

export interface WatchOptions {
  /** Scope root; defaults to the document root. Ancestor traversal during
   *  matching never crosses this node. */
  readonly scope?: ElementNode;
  /** When true, every incremental update is cross-checked against a full
   *  re-match using the naive reference implementation. */
  readonly verify?: boolean;
}

export interface LiveQuery {
  readonly source: string;
  readonly scope: ElementNode;
  /** The current immutable snapshot. */
  readonly snapshot: Snapshot;
  /** Stop receiving updates. */
  dispose(): void;
}

interface InternalState {
  doc: Document;
  plan: Plan;
  callback: LiveCallback | undefined;
  verify: boolean;
  matched: Set<ElementNode>;
  snapshot: { version: number; matches: readonly ElementNode[] };
  pendingDiff: { added: ElementNode[]; removed: ElementNode[] } | null;
  disposed: boolean;
}

const internals = new WeakMap<LiveQuery, InternalState>();

class LiveQueryImpl implements LiveQuery {
  constructor(
    public readonly source: string,
    public readonly scope: ElementNode,
    private readonly state: InternalState,
  ) {}

  get snapshot(): Snapshot {
    return this.state.snapshot;
  }

  dispose(): void {
    this.state.doc.unwatch(this);
  }
}

function freezeSnapshot(
  version: number,
  matches: ElementNode[],
): { version: number; matches: readonly ElementNode[] } {
  return Object.freeze({ version, matches: Object.freeze(matches.slice()) });
}

function verifyAgainstNaive(source: string, scope: ElementNode, ordered: readonly ElementNode[]): void {
  const expected = naiveQuery(scope, source);
  const ok =
    expected.length === ordered.length && expected.every((n, i) => ordered[i] === n);
  if (!ok) {
    const fmt = (nodes: readonly ElementNode[]) =>
      nodes.map((n) => n.tag).join(",") || "(empty)";
    throw new Error(
      `live query verification failed for "${source}": ` +
        `incremental=[${fmt(ordered)}] reference=[${fmt(expected)}]`,
    );
  }
}

export function createLiveQuery(
  doc: Document,
  source: string,
  scope: ElementNode,
  callback: LiveCallback | undefined,
  options?: WatchOptions,
): LiveQuery {
  const plan = compile(source);
  const initial = plan.query(scope);
  const state: InternalState = {
    doc,
    plan,
    callback,
    verify: options?.verify ?? false,
    matched: new Set(initial),
    snapshot: freezeSnapshot(0, initial),
    pendingDiff: null,
    disposed: false,
  };
  if (state.verify) verifyAgainstNaive(source, scope, initial);
  const query = new LiveQueryImpl(source, scope, state);
  internals.set(query, state);
  return query;
}

export function destroyLiveQuery(query: LiveQuery): void {
  const state = internals.get(query);
  if (state) state.disposed = true;
}

/** Add every node of the intersection between subtree(root) and the scope
 *  subtree to `candidates`. */
function addSubtreeIntersection(
  candidates: Set<ElementNode>,
  subtreeRoot: ElementNode,
  scope: ElementNode,
): void {
  if (isWithin(subtreeRoot, scope)) {
    for (const n of preorder(subtreeRoot)) candidates.add(n);
  } else if (isWithin(scope, subtreeRoot)) {
    // The mutation happened on an ancestor of the scope: the whole scope
    // subtree may be affected (descendant combinators reach downwards).
    for (const n of preorder(scope)) candidates.add(n);
  }
}

export function applyBatchToQuery(query: LiveQuery, batch: readonly Mutation[]): void {
  const state = internals.get(query);
  if (!state || state.disposed) return;
  const scope = query.scope;

  const candidates = new Set<ElementNode>();
  const detached = new Set<ElementNode>();
  let structural = false;

  for (const m of batch) {
    if (m.kind === "attr") {
      // An attribute change on N can change the match of N and of every
      // descendant of N (child/descendant combinators look upwards), so the
      // invalidation range is N's whole subtree (intersected with the scope).
      addSubtreeIntersection(candidates, m.node, scope);
    } else if (m.kind === "insert") {
      structural = true;
      addSubtreeIntersection(candidates, m.node, scope);
    } else {
      structural = true;
      for (const n of m.removedNodes) {
        if (state.matched.has(n)) detached.add(n);
      }
    }
  }

  if (candidates.size === 0 && detached.size === 0 && !structural) return;

  for (const n of detached) {
    // A node re-inserted inside the scope within the same batch is handled as
    // a candidate instead.
    if (state.matched.has(n) && !isWithin(n, scope)) {
      state.matched.delete(n);
    }
  }

  for (const n of candidates) {
    if (!isWithin(n, scope)) continue; // moved out of scope later in the batch
    const now = state.plan.matches(n, scope);
    const was = state.matched.has(n);
    if (now && !was) {
      state.matched.add(n);
    } else if (!now && was) {
      state.matched.delete(n);
    }
  }

  // Rebuild the ordered result from the tree so document order is always
  // exact, even for pure reorderings (moves) with no membership change.
  const ordered: ElementNode[] = [];
  for (const n of preorder(scope)) {
    if (state.matched.has(n)) ordered.push(n);
  }

  const prev = state.snapshot.matches;
  const unchanged =
    prev.length === ordered.length && prev.every((n, i) => ordered[i] === n);
  if (unchanged) return;

  // Derive the diff from the ordered lists: additions in document order,
  // removals in previous snapshot order.
  const prevSet = new Set(prev);
  const added = ordered.filter((n) => !prevSet.has(n));
  const removed = prev.filter((n) => !state.matched.has(n));

  if (state.verify) verifyAgainstNaive(query.source, scope, ordered);

  state.snapshot = freezeSnapshot(state.snapshot.version + 1, ordered);
  state.pendingDiff = { added, removed };
}

export function notifyQuery(query: LiveQuery): void {
  const state = internals.get(query);
  if (!state || state.disposed || state.pendingDiff === null) return;
  const diff = state.pendingDiff;
  state.pendingDiff = null;
  if (state.callback === undefined) return;
  const frozen: Diff = Object.freeze({
    added: Object.freeze(diff.added),
    removed: Object.freeze(diff.removed),
    version: state.snapshot.version,
  });
  state.callback(frozen, state.snapshot);
}
