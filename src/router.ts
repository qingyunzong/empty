export type NodeId = string;
export type SessionId = string;

export interface HealthEvent {
  nodeId: NodeId;
  healthy: boolean;
}

export interface Session {
  id: SessionId;
  nodeId: NodeId;
  generation: number;
}

export interface ApplyResult {
  reconnected: SessionId[];
}

interface NodeState {
  id: NodeId;
  weight: number;
  healthy: boolean;
  generation: number;
  loads: Map<number, number>;
}

export class Router {
  private readonly nodes = new Map<NodeId, NodeState>();
  private readonly sessions = new Map<SessionId, Session>();
  private seq = 0;

  addNode(id: NodeId, weight = 1): void {
    if (this.nodes.has(id)) throw new Error(`node already exists: ${id}`);
    if (!(weight > 0)) throw new Error(`weight must be > 0 for node: ${id}`);
    this.nodes.set(id, { id, weight, healthy: true, generation: 0, loads: new Map() });
  }

  openSession(id?: SessionId): Session {
    const sessionId = id ?? `s${++this.seq}`;
    if (this.sessions.has(sessionId)) throw new Error(`session already exists: ${sessionId}`);
    const node = this.pickNode();
    if (!node) throw new Error("no healthy node available");
    const session: Session = { id: sessionId, nodeId: node.id, generation: node.generation };
    this.sessions.set(sessionId, session);
    this.bump(node, node.generation, 1);
    return { ...session };
  }

  closeSession(id: SessionId): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    const node = this.nodes.get(session.nodeId);
    if (node) this.bump(node, session.generation, -1);
    return true;
  }

  applyHealthEvents(events: readonly HealthEvent[]): ApplyResult {
    for (const event of events) {
      if (!this.nodes.has(event.nodeId)) {
        throw new Error(`unknown node: ${event.nodeId}`);
      }
    }
    for (const event of events) {
      const node = this.nodes.get(event.nodeId)!;
      if (event.healthy === node.healthy) continue;
      if (event.healthy) {
        node.generation += 1;
        node.healthy = true;
      } else {
        node.healthy = false;
      }
    }
    const reconnected: SessionId[] = [];
    for (const session of this.sessions.values()) {
      const bound = this.nodes.get(session.nodeId);
      const valid = bound !== undefined && bound.healthy && bound.generation === session.generation;
      if (valid) continue;
      const target = this.pickNode();
      if (!target) continue;
      if (bound) this.bump(bound, session.generation, -1);
      session.nodeId = target.id;
      session.generation = target.generation;
      this.bump(target, target.generation, 1);
      reconnected.push(session.id);
    }
    this.reconcileLoads();
    return { reconnected };
  }

  getLoad(nodeId: NodeId, generation?: number): number {
    const node = this.mustGetNode(nodeId);
    return node.loads.get(generation ?? node.generation) ?? 0;
  }

  getGeneration(nodeId: NodeId): number {
    return this.mustGetNode(nodeId).generation;
  }

  isHealthy(nodeId: NodeId): boolean {
    return this.mustGetNode(nodeId).healthy;
  }

  getSession(id: SessionId): Session | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session } : undefined;
  }

  listSessions(): Session[] {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  private mustGetNode(nodeId: NodeId): NodeState {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`unknown node: ${nodeId}`);
    return node;
  }

  private pickNode(): NodeState | undefined {
    let best: NodeState | undefined;
    let bestScore = Infinity;
    for (const node of this.nodes.values()) {
      if (!node.healthy) continue;
      const score = (node.loads.get(node.generation) ?? 0) / node.weight;
      if (score < bestScore || (score === bestScore && best !== undefined && node.id < best.id)) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  }

  private bump(node: NodeState, generation: number, delta: number): void {
    const next = (node.loads.get(generation) ?? 0) + delta;
    if (next < 0) throw new Error(`load underflow on ${node.id}#${generation}`);
    if (next === 0) node.loads.delete(generation);
    else node.loads.set(generation, next);
  }

  private reconcileLoads(): void {
    const expected = new Map<NodeId, Map<number, number>>();
    for (const session of this.sessions.values()) {
      let perGen = expected.get(session.nodeId);
      if (!perGen) {
        perGen = new Map();
        expected.set(session.nodeId, perGen);
      }
      perGen.set(session.generation, (perGen.get(session.generation) ?? 0) + 1);
    }
    for (const node of this.nodes.values()) {
      const perGen = expected.get(node.id) ?? new Map<number, number>();
      const generations = new Set([...node.loads.keys(), ...perGen.keys()]);
      for (const generation of generations) {
        const counters = node.loads.get(generation) ?? 0;
        const fromSessions = perGen.get(generation) ?? 0;
        if (counters !== fromSessions) {
          throw new Error(
            `load mismatch on ${node.id}#${generation}: counters=${counters}, sessions=${fromSessions}`,
          );
        }
      }
      node.loads = perGen;
    }
  }
}
