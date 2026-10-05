/**
 * Relation store: a versioned directed labeled multigraph.
 *
 * - Edges are directed, labeled and keyed by a unique edge id.
 * - Multiple edges between the same endpoint pair coexist (ids are never merged).
 * - Cycles and self-loops are allowed.
 * - Mutations happen in atomic batches: either every op applies or none does.
 * - diff(a, b) yields added / removed / relabeled edges; invert(diff) applied
 *   to b restores a exactly.
 */

export type EdgeId = string;
export type NodeId = string;

export interface Edge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly label: string;
}

function edgeEquals(a: Edge, b: Edge): boolean {
  return a.id === b.id && a.from === b.from && a.to === b.to && a.label === b.label;
}

function assertValidEdge(edge: Edge): void {
  if (typeof edge.id !== 'string' || edge.id.length === 0) {
    throw new Error(`invalid edge id: ${String(edge.id)}`);
  }
  if (typeof edge.from !== 'string' || edge.from.length === 0) {
    throw new Error(`edge ${edge.id}: invalid source node`);
  }
  if (typeof edge.to !== 'string' || edge.to.length === 0) {
    throw new Error(`edge ${edge.id}: invalid target node`);
  }
  if (typeof edge.label !== 'string') {
    throw new Error(`edge ${edge.id}: label must be a string`);
  }
}

/** An immutable snapshot of the graph: a set of edges keyed by id. */
export class Version {
  readonly #edges: ReadonlyMap<EdgeId, Edge>;

  constructor(edges?: ReadonlyMap<EdgeId, Edge>) {
    this.#edges = edges ?? new Map();
    Object.freeze(this);
  }

  get size(): number {
    return this.#edges.size;
  }

  has(id: EdgeId): boolean {
    return this.#edges.has(id);
  }

  get(id: EdgeId): Edge | undefined {
    return this.#edges.get(id);
  }

  entries(): IterableIterator<Edge> {
    return this.#edges.values();
  }

  toMap(): Map<EdgeId, Edge> {
    return new Map(this.#edges);
  }

  equals(other: Version): boolean {
    if (this.#edges.size !== other.#edges.size) return false;
    for (const [id, edge] of this.#edges) {
      const o = other.#edges.get(id);
      if (o === undefined || !edgeEquals(edge, o)) return false;
    }
    return true;
  }
}

export type BatchOp =
  | { readonly kind: 'add'; readonly edge: Edge }
  | { readonly kind: 'remove'; readonly id: EdgeId }
  | { readonly kind: 'relabel'; readonly id: EdgeId; readonly label: string };

/** A label modification of an edge that keeps its id and endpoints. */
export interface Relabel {
  readonly id: EdgeId;
  readonly from: Edge; // edge image in the source version
  readonly to: Edge;   // edge image in the target version
}

export interface Diff {
  readonly added: readonly Edge[];
  readonly removed: readonly Edge[];
  readonly relabeled: readonly Relabel[];
}

function byId(a: Edge, b: Edge): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class RelationStore {
  #version: Version;

  constructor(initial?: Version) {
    this.#version = initial ?? new Version();
  }

  get version(): Version {
    return this.#version;
  }

  /**
   * Apply a batch of ops atomically. Every op is validated against the working
   * copy; on the first violation the whole batch is rejected and the store
   * keeps its previous version untouched.
   */
  commit(ops: readonly BatchOp[]): Version {
    const working = this.#version.toMap();
    for (const op of ops) {
      switch (op.kind) {
        case 'add': {
          assertValidEdge(op.edge);
          if (working.has(op.edge.id)) {
            throw new Error(`batch rejected: duplicate edge id ${op.edge.id}`);
          }
          working.set(op.edge.id, op.edge);
          break;
        }
        case 'remove': {
          if (!working.has(op.id)) {
            throw new Error(`batch rejected: cannot remove unknown edge ${op.id}`);
          }
          working.delete(op.id);
          break;
        }
        case 'relabel': {
          const edge = working.get(op.id);
          if (edge === undefined) {
            throw new Error(`batch rejected: cannot relabel unknown edge ${op.id}`);
          }
          if (typeof op.label !== 'string') {
            throw new Error(`batch rejected: label for ${op.id} must be a string`);
          }
          working.set(op.id, { ...edge, label: op.label });
          break;
        }
        default: {
          const neverOp: never = op;
          throw new Error(`batch rejected: unknown op ${JSON.stringify(neverOp)}`);
        }
      }
    }
    this.#version = new Version(working);
    return this.#version;
  }
}

/**
 * Difference between two versions, keyed by edge id. Ids present in both
 * versions are never merged or matched by endpoints: identical endpoints with
 * distinct ids are distinct edges. An id whose endpoints changed counts as a
 * removal plus an addition; an id whose label only changed is a relabel.
 */
export function diff(from: Version, to: Version): Diff {
  const added: Edge[] = [];
  const removed: Edge[] = [];
  const relabeled: Relabel[] = [];

  for (const edge of to.entries()) {
    const prev = from.get(edge.id);
    if (prev === undefined) {
      added.push(edge);
    } else if (prev.from !== edge.from || prev.to !== edge.to) {
      removed.push(prev);
      added.push(edge);
    } else if (prev.label !== edge.label) {
      relabeled.push({ id: edge.id, from: prev, to: edge });
    }
  }
  for (const edge of from.entries()) {
    if (!to.has(edge.id)) removed.push(edge);
  }

  added.sort(byId);
  removed.sort(byId);
  relabeled.sort((a, b) => byId(a.to, b.to));
  return { added, removed, relabeled };
}

/** The inverse of a diff: applying it to the target restores the source. */
export function invert(d: Diff): Diff {
  return {
    added: [...d.removed],
    removed: [...d.added],
    relabeled: d.relabeled.map((r) => ({ id: r.id, from: r.to, to: r.from })),
  };
}

/**
 * Apply a diff to a version, validating every entry against the actual
 * version content. Throws without mutating anything on mismatch.
 */
export function applyDiff(base: Version, d: Diff): Version {
  const working = base.toMap();
  for (const edge of d.removed) {
    const cur = working.get(edge.id);
    if (cur === undefined || !edgeEquals(cur, edge)) {
      throw new Error(`cannot apply diff: removed edge ${edge.id} does not match version`);
    }
    working.delete(edge.id);
  }
  for (const r of d.relabeled) {
    const cur = working.get(r.id);
    if (cur === undefined || !edgeEquals(cur, r.from)) {
      throw new Error(`cannot apply diff: relabeled edge ${r.id} does not match version`);
    }
    working.set(r.id, r.to);
  }
  for (const edge of d.added) {
    assertValidEdge(edge);
    if (working.has(edge.id)) {
      throw new Error(`cannot apply diff: added edge ${edge.id} already exists`);
    }
    working.set(edge.id, edge);
  }
  return new Version(working);
}

/**
 * Reverse-diff validation: the inverse of diff(prev, curr) applied to curr
 * must reproduce prev exactly (the "current preimage" check).
 */
export function verifyReverse(prev: Version, curr: Version): boolean {
  const forward = diff(prev, curr);
  const restored = applyDiff(curr, invert(forward));
  return restored.equals(prev);
}
