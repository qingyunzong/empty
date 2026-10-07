import { Dinic, EPS } from './maxflow.js';

export const INF = 1e15;
const BIG = 1e15; // stand-in for "infinite" time-window bounds

export class PlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const invalid = (msg) => new PlannerError('INVALID_INPUT', msg);

function requireString(v, name) {
  if (typeof v !== 'string' || v.length === 0) throw invalid(`${name} must be a non-empty string`);
  if (v.includes('|')) throw invalid(`${name} must not contain '|'`);
}

function requireNumber(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${name} must be a finite number`);
}

function requirePositive(v, name) {
  requireNumber(v, name);
  if (!(v > 0)) throw invalid(`${name} must be > 0`);
}

function requireWindow(w) {
  if (w === undefined || w === null) return [-BIG, BIG];
  if (!Array.isArray(w) || w.length !== 2) throw invalid('window must be [start, end]');
  requireNumber(w[0], 'window[0]');
  requireNumber(w[1], 'window[1]');
  if (!(w[0] <= w[1])) throw invalid('window start must be <= window end');
  return [w[0], w[1]];
}

function emptyState() {
  return { orders: new Map(), slots: new Map(), links: new Map(), machineFactors: new Map() };
}

function cloneState(s) {
  return {
    orders: new Map([...s.orders].map(([k, v]) => [k, { ...v, window: [...v.window] }])),
    slots: new Map([...s.slots].map(([k, v]) => [k, { ...v }])),
    links: new Map([...s.links].map(([k, v]) => [k, { ...v }])),
    machineFactors: new Map(s.machineFactors),
  };
}

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// Apply one mutation command to a state object. Throws PlannerError on invalid input.
function applyMutation(state, c) {
  switch (c.cmd) {
    case 'add_order': {
      requireString(c.id, 'id');
      if (state.orders.has(c.id) || state.slots.has(c.id)) throw invalid(`duplicate id ${c.id}`);
      requirePositive(c.demand, 'demand');
      const window = requireWindow(c.window);
      state.orders.set(c.id, { id: c.id, demand: c.demand, window });
      return;
    }
    case 'add_slot': {
      requireString(c.id, 'id');
      requireString(c.machine, 'machine');
      if (state.slots.has(c.id) || state.orders.has(c.id)) throw invalid(`duplicate id ${c.id}`);
      requireNumber(c.start, 'start');
      requireNumber(c.end, 'end');
      if (!(c.end > c.start)) throw invalid('slot end must be after start');
      requirePositive(c.capacity, 'capacity');
      for (const s of state.slots.values()) {
        if (s.machine === c.machine && overlaps(c.start, c.end, s.start, s.end)) {
          throw invalid(`slot ${c.id} overlaps slot ${s.id} on machine ${c.machine}`);
        }
      }
      state.slots.set(c.id, { id: c.id, machine: c.machine, start: c.start, end: c.end, capacity: c.capacity });
      return;
    }
    case 'link': {
      requireString(c.order, 'order');
      requireString(c.slot, 'slot');
      const o = state.orders.get(c.order);
      if (!o) throw invalid(`unknown order ${c.order}`);
      const s = state.slots.get(c.slot);
      if (!s) throw invalid(`unknown slot ${c.slot}`);
      const key = `${c.order}|${c.slot}`;
      if (state.links.has(key)) throw invalid(`duplicate link ${key}`);
      if (!overlaps(s.start, s.end, o.window[0], o.window[1])) {
        throw invalid(`slot ${c.slot} is outside the time window of order ${c.order}`);
      }
      let capacity = INF;
      if (c.capacity !== undefined) {
        requirePositive(c.capacity, 'capacity');
        capacity = c.capacity;
      }
      state.links.set(key, { order: c.order, slot: c.slot, capacity });
      return;
    }
    case 'slow': {
      requireString(c.machine, 'machine');
      requireNumber(c.factor, 'factor');
      if (!(c.factor > 0 && c.factor <= 1)) throw invalid('factor must be in (0, 1]');
      let known = false;
      for (const s of state.slots.values()) if (s.machine === c.machine) { known = true; break; }
      if (!known) throw invalid(`unknown machine ${c.machine}`);
      state.machineFactors.set(c.machine, (state.machineFactors.get(c.machine) ?? 1) * c.factor);
      return;
    }
    case 'cancel': {
      requireString(c.id, 'id');
      if (state.orders.has(c.id)) {
        state.orders.delete(c.id);
        for (const [k, l] of [...state.links]) if (l.order === c.id) state.links.delete(k);
        return;
      }
      if (state.slots.has(c.id)) {
        state.slots.delete(c.id);
        for (const [k, l] of [...state.links]) if (l.slot === c.id) state.links.delete(k);
        return;
      }
      throw invalid(`unknown id ${c.id}`);
    }
    default:
      throw invalid(`unknown mutation command ${c.cmd}`);
  }
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round = (x) => Math.round((x + Number.EPSILON) * 1e9) / 1e9;

const orderNode = (id) => `order:${id}`;
const slotNode = (id) => `slot:${id}`;
const SOURCE = '@source';
const SINK = '@sink';

function buildNetwork(state) {
  const g = new Dinic();
  const orders = [...state.orders.values()].sort((a, b) => cmpStr(a.id, b.id));
  const slots = [...state.slots.values()].sort((a, b) => a.start - b.start || cmpStr(a.id, b.id));
  const srcEdges = new Map();
  const slotEdges = new Map();
  const linkEdges = new Map();
  for (const o of orders) srcEdges.set(o.id, g.addEdge(SOURCE, orderNode(o.id), o.demand));
  for (const s of slots) {
    const factor = state.machineFactors.get(s.machine) ?? 1;
    slotEdges.set(s.id, g.addEdge(slotNode(s.id), SINK, s.capacity * factor));
  }
  const linksByOrder = new Map();
  for (const l of state.links.values()) {
    if (!linksByOrder.has(l.order)) linksByOrder.set(l.order, []);
    linksByOrder.get(l.order).push(l);
  }
  for (const o of orders) {
    const ls = (linksByOrder.get(o.id) ?? []).sort((a, b) => {
      const sa = state.slots.get(a.slot);
      const sb = state.slots.get(b.slot);
      return sa.start - sb.start || cmpStr(a.slot, b.slot);
    });
    for (const l of ls) {
      linkEdges.set(`${l.order}|${l.slot}`, g.addEdge(orderNode(l.order), slotNode(l.slot), l.capacity));
    }
  }
  return { g, srcEdges, slotEdges, linkEdges };
}

function computeCut(net) {
  const reach = net.g.reachableFrom(SOURCE);
  const cutEdges = [];
  const orders = [];
  const slots = [];
  for (const [id, e] of net.srcEdges) {
    if (!reach.has(orderNode(id))) {
      orders.push(id);
      cutEdges.push({ from: 'source', to: id, kind: 'demand', capacity: round(e.cap) });
    }
  }
  for (const [id, e] of net.slotEdges) {
    if (reach.has(slotNode(id))) {
      slots.push(id);
      cutEdges.push({ from: id, to: 'sink', kind: 'slot_capacity', capacity: round(e.cap) });
    }
  }
  for (const [key, e] of net.linkEdges) {
    const sep = key.indexOf('|');
    const o = key.slice(0, sep);
    const s = key.slice(sep + 1);
    if (reach.has(orderNode(o)) && !reach.has(slotNode(s)) && e.cap < INF / 2) {
      cutEdges.push({ from: o, to: s, kind: 'link', capacity: round(e.cap) });
    }
  }
  orders.sort();
  slots.sort();
  const value = cutEdges.reduce((acc, e) => acc + e.capacity, 0);
  return { value: round(value), orders, slots, cut_edges: cutEdges };
}

function computeFlow(state) {
  const net = buildNetwork(state);
  const value = net.g.maxflow(SOURCE, SINK);
  const assignments = [];
  for (const [key, e] of net.linkEdges) {
    if (e.flow > EPS) {
      const sep = key.indexOf('|');
      const order = key.slice(0, sep);
      const slot = key.slice(sep + 1);
      const s = state.slots.get(slot);
      assignments.push({
        order,
        slot,
        machine: s.machine,
        start: s.start,
        end: s.end,
        quantity: round(e.flow),
      });
    }
  }
  // Deterministic tie-break: order id, then slot start time, then slot id.
  assignments.sort((a, b) => cmpStr(a.order, b.order) || a.start - b.start || cmpStr(a.slot, b.slot));
  const cut = computeCut(net);
  return { net, value, assignments, cut };
}

export class Planner {
  constructor() {
    this.committed = emptyState();
    this.pending = []; // uncommitted corrections (mutation commands)
  }

  // Effective state = committed snapshot + replay of pending corrections.
  currentState() {
    const st = cloneState(this.committed);
    for (const c of this.pending) applyMutation(st, c);
    return st;
  }

  execute(cmd) {
    if (typeof cmd !== 'object' || cmd === null || typeof cmd.cmd !== 'string') {
      throw invalid('command must be an object with a string "cmd"');
    }
    switch (cmd.cmd) {
      case 'add_order':
      case 'add_slot':
      case 'link':
      case 'slow':
      case 'cancel': {
        const st = this.currentState();
        applyMutation(st, cmd); // validate against effective state
        this.pending.push(JSON.parse(JSON.stringify(cmd)));
        return { ok: true, cmd: cmd.cmd };
      }
      case 'commit': {
        if (this.pending.length === 0) {
          throw new PlannerError('CONFLICT', 'nothing to commit: no pending corrections');
        }
        this.committed = this.currentState();
        this.pending = [];
        return { ok: true, cmd: 'commit' };
      }
      case 'undo': {
        if (this.pending.length === 0) {
          throw new PlannerError('UNDO_EMPTY', 'no uncommitted correction to undo');
        }
        this.pending.pop();
        return { ok: true, cmd: 'undo' };
      }
      case 'flow':
        return this.flow();
      case 'verify':
        return this.verify();
      default:
        throw invalid(`unknown command ${cmd.cmd}`);
    }
  }

  flow() {
    const state = this.currentState();
    const { value, assignments, cut } = computeFlow(state);
    return { ok: true, value: round(value), assignments, bottleneck_cut: cut };
  }

  verify() {
    const state = this.currentState();
    const { net, value, cut } = computeFlow(state);
    const details = [];

    // 1. Capacity: 0 <= flow <= capacity on every edge.
    let capacity = true;
    for (const e of net.g.edges) {
      if (!e.forward) continue;
      if (e.flow < -EPS || e.flow > e.cap + EPS) {
        capacity = false;
        details.push(`capacity violated on ${e.from} -> ${e.to}: flow ${e.flow}, cap ${e.cap}`);
      }
    }

    // 2. Conservation: inflow == outflow at every node except source/sink.
    let conservation = true;
    const balance = new Map();
    for (const e of net.g.edges) {
      if (!e.forward || e.flow === 0) continue;
      balance.set(e.from, (balance.get(e.from) ?? 0) - e.flow);
      balance.set(e.to, (balance.get(e.to) ?? 0) + e.flow);
    }
    for (const [node, b] of balance) {
      if (node === SOURCE || node === SINK) continue;
      if (Math.abs(b) > EPS) {
        conservation = false;
        details.push(`conservation violated at ${node}: balance ${b}`);
      }
    }

    // 3. Time windows: every positive assignment links a slot overlapping the order window.
    let timeWindow = true;
    for (const [key, e] of net.linkEdges) {
      if (e.flow <= EPS) continue;
      const sep = key.indexOf('|');
      const o = state.orders.get(key.slice(0, sep));
      const s = state.slots.get(key.slice(sep + 1));
      if (!overlaps(s.start, s.end, o.window[0], o.window[1])) {
        timeWindow = false;
        details.push(`time window violated: order ${o.id} assigned to slot ${s.id}`);
      }
    }

    // 4. Cut equality: min-cut capacity equals the flow value (max-flow min-cut theorem).
    const cutEquality = Math.abs(cut.value - round(value)) <= 1e-6;
    if (!cutEquality) details.push(`cut value ${cut.value} != flow value ${round(value)}`);

    const checks = {
      capacity,
      conservation,
      time_window: timeWindow,
      cut_equality: cutEquality,
    };
    const ok = capacity && conservation && timeWindow && cutEquality;
    const result = {
      ok,
      value: round(value),
      cut_value: cut.value,
      checks,
    };
    if (!ok) {
      result.error = 'VERIFY_FAILED';
      result.details = details;
    }
    return result;
  }
}
