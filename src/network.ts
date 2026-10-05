import { Rng } from "./rng.js";

export interface Customer {
  id: number;
  route: string[];
  routeIndex: number;
  /** remaining service ticks at the current station; 0 means service complete */
  remaining: number;
  serviceDuration: number;
  serviceStartTick: number | null;
}

export interface ServiceRecord {
  customerId: number;
  stationId: string;
  duration: number;
  startTick: number;
  endTick: number | null;
}

export interface StationConfig {
  id: string;
  /** bounded waiting room, not counting customers in service */
  queueCapacity: number;
  servers: number;
  serviceMin: number;
  serviceMax: number;
}

export interface SourceConfig {
  route: string[];
  /** per-tick arrival probability, drawn from the network RNG */
  probability: number;
}

export interface NetworkConfig {
  seed: number;
  stations: StationConfig[];
  sources?: SourceConfig[];
}

export interface TickEvents {
  tick: number;
  arrived: number[];
  dropped: number[];
  completed: Array<{ customerId: number; stationId: string }>;
  moved: Array<{ customerId: number; from: string; to: string }>;
  departed: Array<{ customerId: number; stationId: string }>;
  blocked: Array<{ customerId: number; from: string; to: string }>;
  started: Array<{ customerId: number; stationId: string; duration: number }>;
}

export interface StationCounts {
  queued: number;
  inService: number;
  blocked: number;
}

export interface Snapshot {
  tick: number;
  rngState: number;
  nextCustomerId: number;
  arrived: number;
  dropped: number;
  departed: number;
  stations: Array<{
    id: string;
    queue: Customer[];
    slots: Array<Customer | null>;
  }>;
  serviceLog: ServiceRecord[];
}

class Station {
  readonly cfg: StationConfig;
  readonly queue: Customer[] = [];
  readonly slots: Array<Customer | null>;

  constructor(cfg: StationConfig) {
    this.cfg = cfg;
    this.slots = new Array<Customer | null>(cfg.servers).fill(null);
  }

  get queueFull(): boolean {
    return this.queue.length >= this.cfg.queueCapacity;
  }

  get inServiceCount(): number {
    return this.slots.filter((c) => c !== null).length;
  }

  get blockedCount(): number {
    return this.slots.filter((c) => c !== null && c.remaining === 0).length;
  }
}

/**
 * Tick-based help-desk network.
 *
 * Every tick runs four phases in a fixed order:
 *   1. arrive   - source arrivals are enqueued (or dropped if the bounded
 *                 entry queue is full)
 *   2. complete - one tick of service work; customers reaching remaining=0
 *                 finish service this tick
 *   3. move     - finished customers route downstream; if the downstream
 *                 queue is full the customer stays put and KEEPS OCCUPYING
 *                 the server slot (upstream blocking)
 *   4. start    - free servers pull the next waiting customer into service
 *
 * Because completion is processed before moves, and moves before starts, a
 * customer can finish at station A, move to station B, and begin service at
 * B all within the same tick.
 */
export class Network {
  readonly cfg: NetworkConfig;
  private readonly stations: Station[] = [];
  private readonly byId = new Map<string, Station>();
  private rng: Rng;
  private nextCustomerId = 1;
  private readonly serviceLog: ServiceRecord[] = [];
  private readonly openRecords = new Map<number, ServiceRecord>();

  tickCount = 0;
  arrived = 0;
  dropped = 0;
  departed = 0;

  constructor(cfg: NetworkConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed);
    for (const sc of cfg.stations) {
      if (sc.servers < 1) throw new Error(`station ${sc.id}: servers must be >= 1`);
      if (sc.queueCapacity < 0) throw new Error(`station ${sc.id}: queueCapacity must be >= 0`);
      if (sc.serviceMin < 1 || sc.serviceMax < sc.serviceMin) {
        throw new Error(`station ${sc.id}: need 1 <= serviceMin <= serviceMax`);
      }
      if (this.byId.has(sc.id)) throw new Error(`duplicate station id ${sc.id}`);
      const st = new Station(sc);
      this.stations.push(st);
      this.byId.set(sc.id, st);
    }
    for (const src of cfg.sources ?? []) this.validateRoute(src.route);
  }

  private validateRoute(route: string[]): void {
    if (route.length === 0) throw new Error("route must not be empty");
    for (const id of route) {
      if (!this.byId.has(id)) throw new Error(`unknown station ${id} in route`);
    }
  }

  private station(id: string): Station {
    const st = this.byId.get(id);
    if (!st) throw new Error(`unknown station ${id}`);
    return st;
  }

  /** Inject a customer at the head of its route. Returns id, or null if dropped. */
  inject(route: string[]): number | null {
    this.validateRoute(route);
    const entry = this.station(route[0] as string);
    const customer: Customer = {
      id: this.nextCustomerId++,
      route: [...route],
      routeIndex: 0,
      remaining: 0,
      serviceDuration: 0,
      serviceStartTick: null,
    };
    if (entry.queueFull) {
      this.dropped++;
      return null;
    }
    entry.queue.push(customer);
    this.arrived++;
    return customer.id;
  }

  step(): TickEvents {
    this.tickCount += 1;
    const t = this.tickCount;
    const ev: TickEvents = {
      tick: t,
      arrived: [],
      dropped: [],
      completed: [],
      moved: [],
      departed: [],
      blocked: [],
      started: [],
    };

    // Phase 1: arrivals
    for (const src of this.cfg.sources ?? []) {
      if (this.rng.nextFloat() < src.probability) {
        const id = this.inject(src.route);
        if (id === null) ev.dropped.push(this.nextCustomerId - 1);
        else ev.arrived.push(id);
      }
    }

    // Phase 2: complete (one tick of work, then finish)
    for (const st of this.stations) {
      for (const c of st.slots) {
        if (c === null || c.remaining === 0) continue;
        c.remaining -= 1;
        if (c.remaining === 0) {
          const rec = this.openRecords.get(c.id);
          if (rec) {
            rec.endTick = t;
            this.openRecords.delete(c.id);
          }
          ev.completed.push({ customerId: c.id, stationId: st.cfg.id });
        }
      }
    }

    // Phase 3: move (blocked customers keep their server slot)
    for (const st of this.stations) {
      for (let i = 0; i < st.slots.length; i++) {
        const c = st.slots[i];
        if (c === null || c === undefined || c.remaining > 0) continue;
        const next = c.route[c.routeIndex + 1];
        if (next === undefined) {
          st.slots[i] = null;
          this.departed++;
          ev.departed.push({ customerId: c.id, stationId: st.cfg.id });
          continue;
        }
        const target = this.station(next);
        if (target.queueFull) {
          ev.blocked.push({ customerId: c.id, from: st.cfg.id, to: next });
          continue;
        }
        st.slots[i] = null;
        c.routeIndex += 1;
        target.queue.push(c);
        ev.moved.push({ customerId: c.id, from: st.cfg.id, to: next });
      }
    }

    // Phase 4: start (free servers pull from the bounded queue)
    for (const st of this.stations) {
      for (let i = 0; i < st.slots.length; i++) {
        if (st.slots[i] !== null) continue;
        const c = st.queue.shift();
        if (c === undefined) break;
        const duration = this.rng.nextInt(st.cfg.serviceMin, st.cfg.serviceMax);
        c.remaining = duration;
        c.serviceDuration = duration;
        c.serviceStartTick = t;
        st.slots[i] = c;
        const rec: ServiceRecord = {
          customerId: c.id,
          stationId: st.cfg.id,
          duration,
          startTick: t,
          endTick: null,
        };
        this.serviceLog.push(rec);
        this.openRecords.set(c.id, rec);
        ev.started.push({ customerId: c.id, stationId: st.cfg.id, duration });
      }
    }

    return ev;
  }

  run(ticks: number): TickEvents[] {
    const out: TickEvents[] = [];
    for (let i = 0; i < ticks; i++) out.push(this.step());
    return out;
  }

  counts(): Record<string, StationCounts> {
    const out: Record<string, StationCounts> = {};
    for (const st of this.stations) {
      out[st.cfg.id] = {
        queued: st.queue.length,
        inService: st.inServiceCount,
        blocked: st.blockedCount,
      };
    }
    return out;
  }

  customerCount(): number {
    let n = 0;
    for (const st of this.stations) n += st.queue.length + st.inServiceCount;
    return n;
  }

  getServiceLog(): readonly ServiceRecord[] {
    return this.serviceLog;
  }

  /** Read-only view of one station, for assertions and deadlock evidence. */
  stationState(id: string): {
    queue: readonly Customer[];
    slots: ReadonlyArray<Customer | null>;
  } {
    const st = this.station(id);
    return { queue: st.queue, slots: st.slots };
  }

  /** Deep-copied, JSON-serializable snapshot of the full model state. */
  snapshot(): Snapshot {
    const raw: Snapshot = {
      tick: this.tickCount,
      rngState: this.rng.getState(),
      nextCustomerId: this.nextCustomerId,
      arrived: this.arrived,
      dropped: this.dropped,
      departed: this.departed,
      stations: this.stations.map((st) => ({
        id: st.cfg.id,
        queue: st.queue,
        slots: st.slots,
      })),
      serviceLog: this.serviceLog,
    };
    return JSON.parse(JSON.stringify(raw)) as Snapshot;
  }

  static restore(cfg: NetworkConfig, snap: Snapshot): Network {
    const net = new Network(cfg);
    net.tickCount = snap.tick;
    net.rng = Rng.fromState(snap.rngState);
    net.nextCustomerId = snap.nextCustomerId;
    net.arrived = snap.arrived;
    net.dropped = snap.dropped;
    net.departed = snap.departed;
    for (const ss of snap.stations) {
      const st = net.station(ss.id);
      for (const c of ss.queue) st.queue.push({ ...c, route: [...c.route] });
      ss.slots.forEach((c, i) => {
        st.slots[i] = c === null ? null : { ...c, route: [...c.route] };
      });
    }
    for (const rec of snap.serviceLog) {
      const copy = { ...rec };
      net.serviceLog.push(copy);
      if (copy.endTick === null) net.openRecords.set(copy.customerId, copy);
    }
    return net;
  }
}
