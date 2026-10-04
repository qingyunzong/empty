/**
 * Replicated graph (observed-remove edge set, add-wins).
 *
 * Semantics:
 * - addEdge generates a unique tag per add; an edge is visible while it has
 *   at least one live tag.
 * - removeEdge only removes the tags observed at remove time; concurrent
 *   adds (unknown tags) survive.
 * - Messages may arrive out of order or duplicated: tombstones make apply
 *   idempotent and order-independent, so replicas converge.
 * - The projection may contain cycles; cycles are reported, never
 *   auto-repaired (no edge is deleted implicitly).
 */

export type NodeId = string;

export interface Edge {
  from: NodeId;
  to: NodeId;
}

export interface AddMessage {
  kind: "add";
  from: NodeId;
  to: NodeId;
  tag: string;
}

export interface RemoveMessage {
  kind: "remove";
  from: NodeId;
  to: NodeId;
  /** Tags observed by the remover at remove time. */
  tags: readonly string[];
}

export type Message = AddMessage | RemoveMessage;

export interface Cycle {
  /** Nodes along the cycle; nodes[0] is repeated implicitly at the end. */
  nodes: NodeId[];
}

const keyOf = (from: NodeId, to: NodeId): string => JSON.stringify([from, to]);

export class GraphReplica {
  readonly replicaId: string;
  private counter = 0;
  /** edgeKey -> live tags */
  private readonly live = new Map<string, Set<string>>();
  /** edgeKey -> tags known to be removed (for out-of-order adds) */
  private readonly tombstones = new Map<string, Set<string>>();
  private readonly edgeIndex = new Map<string, Edge>();
  /** Broadcast log of every message produced locally. */
  readonly outbox: Message[] = [];

  constructor(replicaId: string) {
    this.replicaId = replicaId;
  }

  addEdge(from: NodeId, to: NodeId): AddMessage {
    this.counter += 1;
    const msg: AddMessage = {
      kind: "add",
      from,
      to,
      tag: `${this.replicaId}#${this.counter}`,
    };
    this.outbox.push(msg);
    this.apply(msg);
    return msg;
  }

  removeEdge(from: NodeId, to: NodeId): RemoveMessage {
    const observed = [...(this.live.get(keyOf(from, to)) ?? [])];
    const msg: RemoveMessage = { kind: "remove", from, to, tags: observed };
    this.outbox.push(msg);
    this.apply(msg);
    return msg;
  }

  /** Idempotent, order-independent message application. */
  apply(msg: Message): void {
    const key = keyOf(msg.from, msg.to);
    this.edgeIndex.set(key, { from: msg.from, to: msg.to });
    if (msg.kind === "add") {
      const dead = this.tombstones.get(key);
      if (dead?.has(msg.tag)) return; // add arrived after its remove
      let tags = this.live.get(key);
      if (!tags) {
        tags = new Set();
        this.live.set(key, tags);
      }
      tags.add(msg.tag); // Set: duplicate adds are no-ops
    } else {
      const tags = this.live.get(key);
      if (tags) {
        for (const tag of msg.tags) tags.delete(tag);
        if (tags.size === 0) this.live.delete(key);
      }
      if (msg.tags.length > 0) {
        let dead = this.tombstones.get(key);
        if (!dead) {
          dead = new Set();
          this.tombstones.set(key, dead);
        }
        for (const tag of msg.tags) dead.add(tag);
      }
    }
  }

  /** Materialized projection: currently visible edges. */
  edges(): Edge[] {
    const result: Edge[] = [];
    for (const key of this.live.keys()) {
      const edge = this.edgeIndex.get(key);
      if (edge) result.push({ ...edge });
    }
    return result;
  }

  hasEdge(from: NodeId, to: NodeId): boolean {
    return this.live.has(keyOf(from, to));
  }

  /** Adjacency-list projection of visible edges. */
  projection(): Map<NodeId, NodeId[]> {
    const adj = new Map<NodeId, NodeId[]>();
    for (const edge of this.edges()) {
      let next = adj.get(edge.from);
      if (!next) {
        next = [];
        adj.set(edge.from, next);
      }
      next.push(edge.to);
    }
    return adj;
  }

  /**
   * Report cycles in the projection. Detection only: no edge is removed.
   * Each elementary cycle found by DFS back-edges is reported once,
   * normalized to start at its lexicographically smallest node.
   */
  findCycles(): Cycle[] {
    const adj = this.projection();
    const color = new Map<NodeId, "gray" | "black">();
    const stack: NodeId[] = [];
    const seen = new Set<string>();
    const cycles: Cycle[] = [];

    const normalize = (path: NodeId[]): string => {
      let best: string[] | null = null;
      for (let i = 0; i < path.length; i += 1) {
        const rotated = [...path.slice(i), ...path.slice(0, i)];
        if (best === null || rotated.join("") < best.join("")) best = rotated;
      }
      return (best ?? []).join("→");
    };

    const visit = (node: NodeId): void => {
      color.set(node, "gray");
      stack.push(node);
      for (const next of adj.get(node) ?? []) {
        if (next === node) {
          const key = normalize([node]);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({ nodes: [node] });
          }
        } else if (color.get(next) === "gray") {
          const start = stack.indexOf(next);
          const path = stack.slice(start);
          const key = normalize(path);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({ nodes: path });
          }
        } else if (!color.has(next)) {
          visit(next);
        }
      }
      stack.pop();
      color.set(node, "black");
    };

    for (const node of adj.keys()) {
      if (!color.has(node)) visit(node);
    }
    return cycles;
  }

  /**
   * Independent reachability check (BFS over the projection), used to
   * cross-verify cycle evidence without sharing cycle-detection logic.
   */
  isReachable(from: NodeId, to: NodeId): boolean {
    const adj = this.projection();
    // Seed with successors so that from === to requires a real path.
    const visited = new Set<NodeId>([from]);
    const queue: NodeId[] = [];
    for (const next of adj.get(from) ?? []) {
      if (next === to) return true;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
    while (queue.length > 0) {
      const node = queue.shift() as NodeId;
      if (node === to) return true;
      for (const next of adj.get(node) ?? []) {
        if (next === to) return true;
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  /** Canonical fingerprint of converged state (live tags + tombstones). */
  stateSignature(): string {
    const sortMap = (m: Map<string, Set<string>>) =>
      [...m.entries()]
        .map(([k, v]) => [k, [...v].sort()] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1));
    return JSON.stringify({ live: sortMap(this.live), dead: sortMap(this.tombstones) });
  }
}
