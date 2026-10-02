import { Dinic, EPS } from './dinic.js';

const TOL = 1e-6;
const round = (x) => Math.round(x * 1e9) / 1e9;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const err = (status, error) => ({ status, error });
const ok = (extra = {}) => ({ status: 'OK', ...extra });

export class Planner {
  constructor() {
    this.orders = new Map(); // id -> {id, demand, release, due}
    this.slots = new Map(); // id -> {id, machine, start, end, capacity}
    this.links = new Map(); // "order slot" -> {order, slot, capacity|null}
    this.machineFactor = new Map(); // machine -> slowdown factor (default 1)
    this.journal = []; // uncommitted corrections, LIFO
    this.lastResult = null; // last flow() output, checked by verify()
  }

  execute(cmd) {
    if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
      return err('INVALID_INPUT', 'command must be a JSON object');
    }
    switch (cmd.cmd) {
      case 'add_order': return this.addOrder(cmd);
      case 'add_slot': return this.addSlot(cmd);
      case 'link': return this.link(cmd);
      case 'slow': return this.slow(cmd);
      case 'cancel': return this.cancel(cmd);
      case 'commit': return this.commit();
      case 'undo': return this.undo();
      case 'flow': return this.flow();
      case 'verify': return this.verify();
      default: return err('INVALID_INPUT', `unknown command: ${cmd.cmd}`);
    }
  }

  addOrder(c) {
    const { id, demand } = c;
    if (!isNonEmptyString(id)) return err('INVALID_INPUT', 'order id must be a non-empty string');
    if (!isFiniteNumber(demand) || demand < 0) return err('INVALID_INPUT', 'demand must be a non-negative number');
    const release = c.release ?? 0;
    const due = c.due ?? Infinity;
    if (!isFiniteNumber(release)) return err('INVALID_INPUT', 'release must be a finite number');
    if (c.due !== undefined && !isFiniteNumber(c.due)) return err('INVALID_INPUT', 'due must be a finite number');
    if (!(release <= due)) return err('INVALID_INPUT', 'release must be <= due');
    if (this.orders.has(id)) return err('CONFLICT', `duplicate order: ${id}`);
    this.orders.set(id, { id, demand, release, due });
    this.journal.push({ type: 'add_order', id });
    return ok();
  }

  addSlot(c) {
    const { id, machine, start, end, capacity } = c;
    if (!isNonEmptyString(id)) return err('INVALID_INPUT', 'slot id must be a non-empty string');
    if (!isNonEmptyString(machine)) return err('INVALID_INPUT', 'machine must be a non-empty string');
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || !(start < end)) {
      return err('INVALID_INPUT', 'slot window must satisfy start < end');
    }
    if (!isFiniteNumber(capacity) || capacity < 0) return err('INVALID_INPUT', 'capacity must be a non-negative number');
    if (this.slots.has(id)) return err('CONFLICT', `duplicate slot: ${id}`);
    for (const s of this.slots.values()) {
      if (s.machine === machine && s.start < end && start < s.end) {
        return err('INVALID_INPUT', `time window overlaps slot ${s.id} on machine ${machine}`);
      }
    }
    this.slots.set(id, { id, machine, start, end, capacity });
    this.journal.push({ type: 'add_slot', id });
    return ok();
  }

  link(c) {
    const { order, slot } = c;
    if (!isNonEmptyString(order) || !this.orders.has(order)) return err('INVALID_INPUT', `unknown order: ${order}`);
    if (!isNonEmptyString(slot) || !this.slots.has(slot)) return err('INVALID_INPUT', `unknown slot: ${slot}`);
    let capacity = null;
    if (c.capacity !== undefined) {
      if (!isFiniteNumber(c.capacity) || c.capacity < 0) return err('INVALID_INPUT', 'link capacity must be a non-negative number');
      capacity = c.capacity;
    }
    const o = this.orders.get(order);
    const s = this.slots.get(slot);
    if (s.start < o.release - EPS || s.end > o.due + EPS) {
      return err('INVALID_INPUT', `slot ${slot} window [${s.start},${s.end}) outside order ${order} window [${o.release},${o.due})`);
    }
    const key = `${order} ${slot}`;
    if (this.links.has(key)) return err('CONFLICT', `duplicate link: ${order} -> ${slot}`);
    this.links.set(key, { order, slot, capacity });
    this.journal.push({ type: 'link', key });
    return ok();
  }

  slow(c) {
    const { machine, factor } = c;
    if (!isNonEmptyString(machine)) return err('INVALID_INPUT', 'machine must be a non-empty string');
    if (!isFiniteNumber(factor) || factor <= 0) return err('INVALID_INPUT', 'factor must be a positive number');
    const had = this.machineFactor.has(machine);
    const prev = had ? this.machineFactor.get(machine) : 1;
    this.machineFactor.set(machine, prev * factor);
    this.journal.push({ type: 'slow', machine, prev, had });
    return ok();
  }

  cancel(c) {
    const { id } = c;
    if (!isNonEmptyString(id)) return err('INVALID_INPUT', 'cancel id must be a non-empty string');
    if (this.orders.has(id)) {
      const order = this.orders.get(id);
      const links = [...this.links.entries()].filter(([, l]) => l.order === id);
      for (const [key] of links) this.links.delete(key);
      this.orders.delete(id);
      this.journal.push({ type: 'cancel_order', order, links });
      return ok();
    }
    if (this.slots.has(id)) {
      const slot = this.slots.get(id);
      const links = [...this.links.entries()].filter(([, l]) => l.slot === id);
      for (const [key] of links) this.links.delete(key);
      this.slots.delete(id);
      this.journal.push({ type: 'cancel_slot', slot, links });
      return ok();
    }
    return err('INVALID_INPUT', `unknown order or slot: ${id}`);
  }

  commit() {
    if (this.journal.length === 0) return err('CONFLICT', 'nothing to commit');
    this.journal = [];
    return ok();
  }

  undo() {
    if (this.journal.length === 0) return err('UNDO_EMPTY', 'no uncommitted correction to undo');
    const entry = this.journal.pop();
    switch (entry.type) {
      case 'add_order':
        this.orders.delete(entry.id);
        for (const [key, l] of [...this.links.entries()]) if (l.order === entry.id) this.links.delete(key);
        break;
      case 'add_slot':
        this.slots.delete(entry.id);
        for (const [key, l] of [...this.links.entries()]) if (l.slot === entry.id) this.links.delete(key);
        break;
      case 'link':
        this.links.delete(entry.key);
        break;
      case 'slow':
        if (entry.had) this.machineFactor.set(entry.machine, entry.prev);
        else this.machineFactor.delete(entry.machine);
        break;
      case 'cancel_order':
        this.orders.set(entry.order.id, entry.order);
        for (const [key, l] of entry.links) this.links.set(key, l);
        break;
      case 'cancel_slot':
        this.slots.set(entry.slot.id, entry.slot);
        for (const [key, l] of entry.links) this.links.set(key, l);
        break;
    }
    return ok();
  }

  slotCapacity(slot) {
    return slot.capacity * (this.machineFactor.get(slot.machine) ?? 1);
  }

  bigM() {
    let total = 1;
    for (const o of this.orders.values()) total += o.demand;
    for (const s of this.slots.values()) total += this.slotCapacity(s);
    return total;
  }

  cutCapacity(cut) {
    const cutOrders = new Set(cut.orders);
    const cutSlots = new Set(cut.slots);
    let value = 0;
    for (const o of this.orders.values()) if (!cutOrders.has(o.id)) value += o.demand;
    for (const s of this.slots.values()) if (cutSlots.has(s.id)) value += this.slotCapacity(s);
    for (const l of this.links.values()) {
      if (cutOrders.has(l.order) && !cutSlots.has(l.slot)) value += l.capacity ?? this.bigM();
    }
    return value;
  }

  buildNetwork() {
    const orders = [...this.orders.values()].sort((a, b) => cmpStr(a.id, b.id));
    const slots = [...this.slots.values()].sort(
      (a, b) => a.start - b.start || a.end - b.end || cmpStr(a.id, b.id),
    );
    const orderNode = new Map(orders.map((o, i) => [o.id, 2 + i]));
    const slotNode = new Map(slots.map((s, j) => [s.id, 2 + orders.length + j]));
    const dinic = new Dinic(2 + orders.length + slots.length);
    const big = this.bigM();
    for (const o of orders) dinic.addEdge(0, orderNode.get(o.id), o.demand);
    const byOrder = new Map(orders.map((o) => [o.id, []]));
    for (const l of this.links.values()) byOrder.get(l.order).push(l);
    const slotRank = new Map(slots.map((s, j) => [s.id, j]));
    const linkEdge = new Map();
    for (const o of orders) {
      const olinks = byOrder.get(o.id).sort((a, b) => slotRank.get(a.slot) - slotRank.get(b.slot));
      for (const l of olinks) {
        const idx = dinic.addEdge(orderNode.get(l.order), slotNode.get(l.slot), l.capacity ?? big);
        linkEdge.set(`${l.order} ${l.slot}`, idx);
      }
    }
    for (const s of slots) dinic.addEdge(slotNode.get(s.id), 1, this.slotCapacity(s));
    return { orders, slots, orderNode, slotNode, dinic, linkEdge };
  }

  flow() {
    const net = this.buildNetwork();
    const value = net.dinic.maxFlow(0, 1);
    const seen = net.dinic.reachableFrom(0);
    const assignments = [];
    for (const [key, edgeIdx] of net.linkEdge) {
      const f = net.dinic.flowOn(edgeIdx);
      if (f > EPS) {
        const l = this.links.get(key);
        const s = this.slots.get(l.slot);
        assignments.push({
          order: l.order, slot: l.slot, machine: s.machine,
          start: s.start, end: s.end, qty: round(f),
        });
      }
    }
    assignments.sort(
      (a, b) => cmpStr(a.order, b.order) || a.start - b.start || a.end - b.end || cmpStr(a.slot, b.slot),
    );
    const cut = {
      orders: net.orders.filter((o) => seen[net.orderNode.get(o.id)]).map((o) => o.id),
      slots: net.slots.filter((s) => seen[net.slotNode.get(s.id)]).map((s) => s.id),
    };
    const result = {
      value: round(value),
      assignments,
      bottleneck_cut: { value: round(this.cutCapacity(cut)), orders: cut.orders, slots: cut.slots },
    };
    this.lastResult = result;
    return ok(result);
  }

  verify() {
    if (!this.lastResult) return err('CONFLICT', 'no flow result to verify');
    const r = this.lastResult;
    let conservation = true;
    let capacity = true;
    let timeWindow = true;
    const perOrder = new Map();
    const perSlot = new Map();
    const seenLinks = new Set();
    let total = 0;
    for (const a of r.assignments) {
      const key = `${a.order} ${a.slot}`;
      const o = this.orders.get(a.order);
      const s = this.slots.get(a.slot);
      const l = this.links.get(key);
      if (!o || !s || !l || seenLinks.has(key) || !isFiniteNumber(a.qty) || !(a.qty > EPS)) {
        conservation = false;
        continue;
      }
      seenLinks.add(key);
      total += a.qty;
      perOrder.set(a.order, (perOrder.get(a.order) ?? 0) + a.qty);
      perSlot.set(a.slot, (perSlot.get(a.slot) ?? 0) + a.qty);
      if (l.capacity !== null && a.qty > l.capacity + EPS) capacity = false;
      if (s.start < o.release - EPS || s.end > o.due + EPS) timeWindow = false;
    }
    if (Math.abs(total - r.value) > TOL) conservation = false;
    for (const [id, v] of perOrder) {
      if (v > this.orders.get(id).demand + EPS) capacity = false;
    }
    for (const [id, v] of perSlot) {
      const s = this.slots.get(id);
      if (s && v > this.slotCapacity(s) + EPS) capacity = false;
    }
    const cut = r.bottleneck_cut;
    const cutShapeOk = cut && Array.isArray(cut.orders) && Array.isArray(cut.slots)
      && cut.orders.every((id) => this.orders.has(id))
      && cut.slots.every((id) => this.slots.has(id));
    const cutEqualsFlow = Boolean(cutShapeOk)
      && Math.abs(this.cutCapacity(cut) - r.value) <= TOL
      && Math.abs(cut.value - r.value) <= TOL;
    const checks = { conservation, capacity, time_window: timeWindow, cut_equals_flow: cutEqualsFlow };
    return ok({ valid: Object.values(checks).every(Boolean), checks });
  }
}
