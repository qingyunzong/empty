export type NodeId = string;
export type SessionId = string;

export interface NodeConfig {
  id: NodeId;
  weight: number;
}

export interface NodeSnapshot {
  id: NodeId;
  weight: number;
  healthy: boolean;
  generation: number;
  load: number;
}

export interface SessionBinding {
  id: SessionId;
  nodeId: NodeId;
  generation: number;
}

export type HealthEvent =
  | { type: "up"; nodeId: NodeId }
  | { type: "down"; nodeId: NodeId };

export interface ReconcileReport {
  ok: boolean;
  discrepancies: Array<{
    nodeId: NodeId;
    generation: number;
    tracked: number;
    recomputed: number;
  }>;
}

interface NodeState {
  id: NodeId;
  weight: number;
  healthy: boolean;
  generation: number;
  load: number;
}

function cloneNodes(nodes: Map<NodeId, NodeState>): Map<NodeId, NodeState> {
  const copy = new Map<NodeId, NodeState>();
  for (const [id, n] of nodes) copy.set(id, { ...n });
  return copy;
}

export class GenerationRouter {
  private nodes = new Map<NodeId, NodeState>();
  private sessions = new Map<SessionId, SessionBinding>();
  private nextSessionSeq = 1;

  constructor(configs: NodeConfig[]) {
    if (configs.length === 0) throw new Error("router requires at least one node");
    for (const c of configs) {
      if (this.nodes.has(c.id)) throw new Error(`duplicate node id: ${c.id}`);
      if (!(c.weight > 0)) throw new Error(`node ${c.id} weight must be > 0`);
      this.nodes.set(c.id, {
        id: c.id,
        weight: c.weight,
        healthy: true,
        generation: 1,
        load: 0,
      });
    }
  }

  /** Weighted least-loaded healthy node: min(load / weight), ties broken by id. */
  private pickNode(): NodeState {
    let best: NodeState | undefined;
    let bestScore = Infinity;
    for (const n of this.nodes.values()) {
      if (!n.healthy) continue;
      const score = n.load / n.weight;
      if (score < bestScore || (score === bestScore && best !== undefined && n.id < best.id)) {
        best = n;
        bestScore = score;
      }
    }
    if (best === undefined) throw new Error("no healthy node available");
    return best;
  }

  /** Open a new session bound to the current generation of the chosen node. */
  openSession(id?: SessionId): SessionBinding {
    const sessionId = id ?? `s${this.nextSessionSeq++}`;
    if (this.sessions.has(sessionId)) throw new Error(`duplicate session id: ${sessionId}`);
    const node = this.pickNode();
    node.load += 1;
    const binding: SessionBinding = { id: sessionId, nodeId: node.id, generation: node.generation };
    this.sessions.set(sessionId, binding);
    return { ...binding };
  }

  /**
   * Close a session. Only decrements the load of the generation the session
   * was bound to; if the node has since moved to a new generation, the stale
   * close leaves the current generation's load untouched. Unknown ids no-op.
   */
  closeSession(id: SessionId): boolean {
    const binding = this.sessions.get(id);
    if (binding === undefined) return false;
    this.sessions.delete(id);
    const node = this.nodes.get(binding.nodeId);
    if (node !== undefined && node.generation === binding.generation && node.load > 0) {
      node.load -= 1;
    }
    return true;
  }

  /**
   * Reconnect a live session whose node failed (or any live session) to the
   * weighted least-loaded healthy node, binding to that node's current
   * generation. The old generation's load is released only if still current.
   */
  reconnect(id: SessionId): SessionBinding {
    const binding = this.sessions.get(id);
    if (binding === undefined) throw new Error(`unknown session: ${id}`);
    const oldNode = this.nodes.get(binding.nodeId);
    if (oldNode !== undefined && oldNode.generation === binding.generation && oldNode.load > 0) {
      oldNode.load -= 1;
    }
    const node = this.pickNode();
    node.load += 1;
    const next: SessionBinding = { id, nodeId: node.id, generation: node.generation };
    this.sessions.set(id, next);
    return { ...next };
  }

  /**
   * Apply a batch of health events atomically: every event is validated and
   * applied against a private copy; the batch commits only if all events are
   * valid, otherwise the router state is left untouched.
   *
   * Each applied event starts a new generation for the node (load resets to
   * zero). Existing sessions keep their bindings — a recovering node never
   * steals sessions from other nodes; only explicit reconnect moves them.
   */
  applyHealthEvents(events: HealthEvent[]): void {
    const next = cloneNodes(this.nodes);
    for (const ev of events) {
      const node = next.get(ev.nodeId);
      if (node === undefined) throw new Error(`unknown node in health event: ${ev.nodeId}`);
      const type = (ev as { type: unknown }).type;
      if (type !== "up" && type !== "down") {
        throw new Error(`invalid health event type: ${String(type)}`);
      }
      node.healthy = ev.type === "up";
      node.generation += 1;
      node.load = 0;
    }
    this.nodes = next;
  }

  /**
   * Recompute per-(node, generation) load from the session table and verify
   * the tracked counters. Detects drift affecting reconnects and stale closes.
   */
  verify(): ReconcileReport {
    const recomputed = new Map<NodeId, number>();
    for (const binding of this.sessions.values()) {
      const node = this.nodes.get(binding.nodeId);
      if (node === undefined || node.generation !== binding.generation) continue;
      recomputed.set(binding.nodeId, (recomputed.get(binding.nodeId) ?? 0) + 1);
    }
    const discrepancies: ReconcileReport["discrepancies"] = [];
    const ids = new Set<NodeId>([...recomputed.keys(), ...this.nodes.keys()]);
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      const expected = recomputed.get(id) ?? 0;
      if (node.load !== expected) {
        discrepancies.push({
          nodeId: id,
          generation: node.generation,
          tracked: node.load,
          recomputed: expected,
        });
      }
    }
    return { ok: discrepancies.length === 0, discrepancies };
  }

  /** Repair tracked load counters from the session table. Returns the report. */
  reconcile(): ReconcileReport {
    const report = this.verify();
    for (const d of report.discrepancies) {
      const node = this.nodes.get(d.nodeId);
      if (node !== undefined) node.load = d.recomputed;
    }
    return report;
  }

  getSession(id: SessionId): SessionBinding | undefined {
    const b = this.sessions.get(id);
    return b === undefined ? undefined : { ...b };
  }

  listSessions(): SessionBinding[] {
    return [...this.sessions.values()].map((b) => ({ ...b }));
  }

  getNode(id: NodeId): NodeSnapshot | undefined {
    const n = this.nodes.get(id);
    return n === undefined ? undefined : { ...n };
  }

  listNodes(): NodeSnapshot[] {
    return [...this.nodes.values()].map((n) => ({ ...n }));
  }
}
