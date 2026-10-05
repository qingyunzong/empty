// Tick-based service-desk network simulation.
//
// Semantics per tick (same-tick order: complete -> move -> start):
//   1. complete: busy servers count down; a finished customer unloads into the
//      desk's bounded output queue. If the output queue is full, the customer
//      stays in the server and the desk keeps its service slot occupied
//      (blocking-after-service).
//   2. move: sink desks drain; customers flow along edges from a desk's output
//      queue into the downstream desk's bounded input queue while capacity
//      allows; sources inject new customers.
//   3. start: idle servers with a waiting input queue take the next customer
//      and begin service.

export interface ServiceRecord {
  desk: string;
  serviceTime: number;
  startedAt: number;
  completedAt: number; // -1 until the customer unloads from the server
}

export interface Customer {
  id: number;
  history: ServiceRecord[];
}

export interface ServerSlot {
  customer: Customer;
  remaining: number;
  blocked: boolean; // service finished but the output queue had no room
}

export interface DeskState {
  input: Customer[];
  server: ServerSlot | null;
  output: Customer[];
}

export interface DeskConfig {
  id: string;
  inputCapacity: number;
  outputCapacity: number;
  serviceTime: number | ((customer: Customer) => number);
}

export interface Edge {
  from: string;
  to: string;
}

export interface SourceConfig {
  desk: string;
  firstTick: number;
  interval: number;
  total: number;
}

export interface NetworkConfig {
  desks: DeskConfig[];
  edges: Edge[];
  sinks?: string[]; // desks whose output queue drains out of the system
  sources?: SourceConfig[];
}

interface SourceState extends SourceConfig {
  emitted: number;
}

export interface WaitEdgeEvidence {
  from: string;
  to: string;
  waitingCustomerIds: number[];
  downstreamInputOccupancy: number;
  downstreamInputCapacity: number;
}

export interface CircularWaitEvidence {
  cycle: string[];
  edges: WaitEdgeEvidence[];
}

export interface Snapshot {
  time: number;
  nextCustomerId: number;
  departed: Customer[];
  desks: Record<string, DeskState>;
  sources: SourceState[];
}

function cloneCustomer(customer: Customer): Customer {
  return { id: customer.id, history: customer.history.map((r) => ({ ...r })) };
}

function cloneDeskState(state: DeskState): DeskState {
  return {
    input: state.input.map(cloneCustomer),
    server: state.server
      ? {
          customer: cloneCustomer(state.server.customer),
          remaining: state.server.remaining,
          blocked: state.server.blocked,
        }
      : null,
    output: state.output.map(cloneCustomer),
  };
}

export class Network {
  readonly config: NetworkConfig;
  private readonly deskConfigs: Map<string, DeskConfig>;
  private time = 0;
  private nextCustomerId = 1;
  private departed: Customer[] = [];
  private desks: Map<string, DeskState> = new Map();
  private sources: SourceState[];

  constructor(config: NetworkConfig) {
    this.config = config;
    this.deskConfigs = new Map(config.desks.map((d) => [d.id, d]));
    for (const desk of config.desks) {
      this.desks.set(desk.id, { input: [], server: null, output: [] });
    }
    this.sources = (config.sources ?? []).map((s) => ({ ...s, emitted: 0 }));
  }

  get currentTime(): number {
    return this.time;
  }

  deskState(id: string): DeskState {
    const state = this.desks.get(id);
    if (!state) throw new Error(`unknown desk: ${id}`);
    return state;
  }

  deskIds(): string[] {
    return [...this.desks.keys()];
  }

  departedCustomers(): readonly Customer[] {
    return this.departed;
  }

  customerCount(): number {
    let total = 0;
    for (const state of this.desks.values()) {
      total += state.input.length + state.output.length + (state.server ? 1 : 0);
    }
    return total;
  }

  private deskConfig(id: string): DeskConfig {
    const cfg = this.deskConfigs.get(id);
    if (!cfg) throw new Error(`unknown desk: ${id}`);
    return cfg;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  tick(): void {
    this.time++;
    this.completePhase();
    this.movePhase();
    this.startPhase();
  }

  // Phase 1: count down service; unload finished customers into the bounded
  // output queue. A full output queue keeps the customer in the server slot.
  private completePhase(): void {
    for (const [id, state] of this.desks) {
      const cfg = this.deskConfig(id);
      const slot = state.server;
      if (!slot) continue;
      if (!slot.blocked) {
        slot.remaining--;
        if (slot.remaining > 0) continue;
      }
      if (state.output.length < cfg.outputCapacity) {
        const record = slot.customer.history[slot.customer.history.length - 1];
        if (record) record.completedAt = this.time;
        state.output.push(slot.customer);
        state.server = null;
      } else {
        slot.blocked = true;
      }
    }
  }

  // Phase 2: sinks drain, edges transfer while downstream capacity allows,
  // sources inject new customers.
  private movePhase(): void {
    for (const sinkId of this.config.sinks ?? []) {
      const state = this.deskState(sinkId);
      while (state.output.length > 0) {
        this.departed.push(state.output.shift()!);
      }
    }
    for (const edge of this.config.edges) {
      const from = this.deskState(edge.from);
      const toCfg = this.deskConfig(edge.to);
      const to = this.deskState(edge.to);
      while (from.output.length > 0 && to.input.length < toCfg.inputCapacity) {
        to.input.push(from.output.shift()!);
      }
    }
    for (const source of this.sources) {
      if (source.emitted >= source.total) continue;
      if (this.time < source.firstTick) continue;
      if ((this.time - source.firstTick) % source.interval !== 0) continue;
      const cfg = this.deskConfig(source.desk);
      const state = this.deskState(source.desk);
      if (state.input.length >= cfg.inputCapacity) continue; // no room: try next tick
      state.input.push({ id: this.nextCustomerId++, history: [] });
      source.emitted++;
    }
  }

  // Phase 3: idle servers start service on the next waiting customer.
  private startPhase(): void {
    for (const [id, state] of this.desks) {
      if (state.server || state.input.length === 0) continue;
      const cfg = this.deskConfig(id);
      const customer = state.input.shift()!;
      const serviceTime =
        typeof cfg.serviceTime === "function"
          ? cfg.serviceTime(customer)
          : cfg.serviceTime;
      if (!Number.isInteger(serviceTime) || serviceTime < 1) {
        throw new Error(`desk ${id}: serviceTime must be an integer >= 1`);
      }
      customer.history.push({
        desk: id,
        serviceTime,
        startedAt: this.time,
        completedAt: -1,
      });
      state.server = { customer, remaining: serviceTime, blocked: false };
    }
  }

  // Wait-for graph: desk A waits on desk B when A holds a customer that wants
  // to enter B (blocked server slot or non-empty output queue on edge A->B)
  // while B's input queue is full.
  private waitForEdges(): WaitEdgeEvidence[] {
    const edges: WaitEdgeEvidence[] = [];
    for (const edge of this.config.edges) {
      const from = this.deskState(edge.from);
      const toCfg = this.deskConfig(edge.to);
      const to = this.deskState(edge.to);
      if (to.input.length < toCfg.inputCapacity) continue;
      const waiting: number[] = from.output.map((c) => c.id);
      if (from.server?.blocked) waiting.push(from.server.customer.id);
      if (waiting.length === 0) continue;
      edges.push({
        from: edge.from,
        to: edge.to,
        waitingCustomerIds: waiting,
        downstreamInputOccupancy: to.input.length,
        downstreamInputCapacity: toCfg.inputCapacity,
      });
    }
    return edges;
  }

  // Reports evidence of a circular wait (deadlock cycle), or null.
  detectCircularWait(): CircularWaitEvidence | null {
    const waitEdges = this.waitForEdges();
    const adjacency = new Map<string, WaitEdgeEvidence[]>();
    for (const edge of waitEdges) {
      const list = adjacency.get(edge.from) ?? [];
      list.push(edge);
      adjacency.set(edge.from, list);
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const stack: WaitEdgeEvidence[] = [];

    const dfs = (node: string): CircularWaitEvidence | null => {
      visiting.add(node);
      for (const edge of adjacency.get(node) ?? []) {
        if (done.has(edge.to)) continue;
        if (visiting.has(edge.to)) {
          const start = stack.findIndex((e) => e.from === edge.to);
          const cycleEdges = [...stack.slice(start), edge];
          const cycle = [edge.to, ...cycleEdges.map((e) => e.to)];
          return { cycle, edges: cycleEdges };
        }
        stack.push(edge);
        const found = dfs(edge.to);
        if (found) return found;
        stack.pop();
      }
      visiting.delete(node);
      done.add(node);
      return null;
    };

    for (const id of this.desks.keys()) {
      if (done.has(id)) continue;
      const found = dfs(id);
      if (found) return found;
    }
    return null;
  }

  snapshot(): Snapshot {
    const desks: Record<string, DeskState> = {};
    for (const [id, state] of this.desks) desks[id] = cloneDeskState(state);
    return {
      time: this.time,
      nextCustomerId: this.nextCustomerId,
      departed: this.departed.map(cloneCustomer),
      desks,
      sources: this.sources.map((s) => ({ ...s })),
    };
  }

  static fromSnapshot(config: NetworkConfig, snapshot: Snapshot): Network {
    const network = new Network(config);
    network.time = snapshot.time;
    network.nextCustomerId = snapshot.nextCustomerId;
    network.departed = snapshot.departed.map(cloneCustomer);
    network.sources = snapshot.sources.map((s) => ({ ...s }));
    for (const id of network.desks.keys()) {
      const state = snapshot.desks[id];
      if (!state) throw new Error(`snapshot missing desk: ${id}`);
      network.desks.set(id, cloneDeskState(state));
    }
    return network;
  }
}

// Per-tick observation used to cross-check a replayed run against the
// original: customer counts per desk compartment plus full service history.
export interface TickObservation {
  time: number;
  counts: Record<string, { input: number; server: number; output: number }>;
  departedCount: number;
  serviceRecords: { customerId: number; desk: string; serviceTime: number }[];
}

export function observe(network: Network): TickObservation {
  const counts: TickObservation["counts"] = {};
  const serviceRecords: TickObservation["serviceRecords"] = [];
  const collect = (customer: Customer) => {
    for (const record of customer.history) {
      serviceRecords.push({
        customerId: customer.id,
        desk: record.desk,
        serviceTime: record.serviceTime,
      });
    }
  };
  for (const id of network.deskIds()) {
    const state = network.deskState(id);
    counts[id] = {
      input: state.input.length,
      server: state.server ? 1 : 0,
      output: state.output.length,
    };
    state.input.forEach(collect);
    if (state.server) collect(state.server.customer);
    state.output.forEach(collect);
  }
  network.departedCustomers().forEach(collect);
  serviceRecords.sort((a, b) =>
    a.customerId - b.customerId || a.desk.localeCompare(b.desk),
  );
  return {
    time: network.currentTime,
    counts,
    departedCount: network.departedCustomers().length,
    serviceRecords,
  };
}
