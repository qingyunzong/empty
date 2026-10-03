import { createHash } from 'node:crypto';
import { SlotIndex } from './slotindex.js';

export const SLOT_MS = 15 * 60 * 1000;

export class PlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Accepts an integer slot index or an ISO timestamp aligned to 15 minutes.
export function toSlot(t) {
  if (typeof t === 'number' && Number.isInteger(t)) return t;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) throw new PlanError('E_INPUT', `invalid time: ${t}`);
    if (ms % SLOT_MS !== 0) {
      throw new PlanError('E_INPUT', `time not aligned to 15 minutes: ${t}`);
    }
    return ms / SLOT_MS;
  }
  throw new PlanError('E_INPUT', `invalid time: ${String(t)}`);
}

function predicateKey(wc, start, end) {
  return `${wc}|${start}|${end}`;
}

function hashPredicate(p) {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}

// Naive reference: per-slot occupancy of a plain order list over [start, end).
export function naiveOccupancy(orders, wc, start, end) {
  const out = new Array(end - start).fill(0);
  for (const o of orders) {
    if (o.workcenter !== wc) continue;
    const lo = Math.max(start, o.start);
    const hi = Math.min(end, o.end);
    for (let s = lo; s < hi; s++) out[s - start] += o.qty;
  }
  return out;
}

export class Store {
  constructor() {
    this.seq = 0; // commit sequence, doubles as snapshot version
    this.orders = new Map(); // orderId -> [ { commitSeq, op: 'put'|'del', order } ]
    this.index = new SlotIndex(); // latest committed state
    this.capacity = new Map(); // wc -> Map<slot, capacity>
    this.txns = new Map(); // txnId -> txn state
    this.nextTxnId = 1;
  }

  setCapacity(wc, start, end, capacity) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new PlanError('E_INPUT', 'capacity must be a non-negative integer');
    }
    let m = this.capacity.get(wc);
    if (!m) {
      m = new Map();
      this.capacity.set(wc, m);
    }
    for (let s = start; s < end; s++) m.set(s, capacity);
  }

  capacityAt(wc, slot) {
    const m = this.capacity.get(wc);
    return m ? m.get(slot) || 0 : 0;
  }

  begin() {
    const id = this.nextTxnId++;
    this.txns.set(id, {
      id,
      snapshot: this.seq,
      predicates: new Map(), // key -> { workcenter, start, end, occupancy }
      ops: new Map(), // orderId -> { type, order, base }
    });
    return { txn: id, snapshot: this.seq };
  }

  #txn(txnId) {
    const t = this.txns.get(txnId);
    if (!t) throw new PlanError('E_TXN', `unknown or closed transaction: ${txnId}`);
    return t;
  }

  // Latest committed version of an order (or null).
  #committed(orderId) {
    const vs = this.orders.get(orderId);
    if (!vs || vs.length === 0) return null;
    const v = vs[vs.length - 1];
    return v.op === 'put' ? v.order : null;
  }

  // Orders visible at a given snapshot sequence.
  visibleOrders(seq) {
    const out = [];
    for (const vs of this.orders.values()) {
      let visible = null;
      for (const v of vs) {
        if (v.commitSeq > seq) break;
        visible = v.op === 'put' ? v.order : null;
      }
      if (visible) out.push(visible);
    }
    return out;
  }

  // Pending per-slot deltas of a transaction: Map wc -> Map<slot, delta>
  #pendingDeltas(t) {
    const deltas = new Map();
    const bump = (wc, slot, d) => {
      let m = deltas.get(wc);
      if (!m) {
        m = new Map();
        deltas.set(wc, m);
      }
      m.set(slot, (m.get(slot) || 0) + d);
    };
    const applyOrder = (o, sign) => {
      for (let s = o.start; s < o.end; s++) bump(o.workcenter, s, sign * o.qty);
    };
    for (const op of t.ops.values()) {
      if (op.type === 'insert') applyOrder(op.order, +1);
      else if (op.type === 'cancel') applyOrder(op.base, -1);
      else if (op.type === 'adjust') {
        applyOrder(op.base, -1);
        applyOrder(op.order, +1);
      }
    }
    return deltas;
  }

  // Read occupancy for (wc, [start,end)): snapshot view plus own pending writes.
  // Records the predicate (snapshot-only occupancy) for commit-time validation.
  read(txnId, wc, start, end) {
    const t = this.#txn(txnId);
    const base = naiveOccupancy(this.visibleOrders(t.snapshot), wc, start, end);
    const key = predicateKey(wc, start, end);
    if (!t.predicates.has(key)) {
      t.predicates.set(key, { workcenter: wc, start, end, occupancy: base });
    }
    const own = this.#pendingDeltas(t).get(wc);
    const occupancy = base.map((q, i) => q + (own?.get(start + i) || 0));
    return {
      workcenter: wc,
      start,
      end,
      occupancy,
      remaining: occupancy.map((q, i) => this.capacityAt(wc, start + i) - q),
    };
  }

  insert(txnId, order) {
    const t = this.#txn(txnId);
    const o = {
      id: order.id,
      workcenter: order.workcenter,
      start: order.start,
      end: order.end,
      qty: order.qty,
    };
    if (!o.id || !o.workcenter) throw new PlanError('E_INPUT', 'order needs id and workcenter');
    if (!Number.isInteger(o.qty) || o.qty <= 0) throw new PlanError('E_INPUT', 'qty must be a positive integer');
    if (!(o.start < o.end)) throw new PlanError('E_INPUT', 'start must be before end');
    if (t.ops.has(o.id)) throw new PlanError('E_INPUT', `order already pending in txn: ${o.id}`);
    if (this.#committed(o.id)) throw new PlanError('E_INPUT', `order already exists: ${o.id}`);
    t.ops.set(o.id, { type: 'insert', order: o });
    return { ok: true, order: o };
  }

  // Base for adjust/cancel: own pending op's current state, else committed order.
  #baseFor(t, orderId) {
    const pending = t.ops.get(orderId);
    if (pending) {
      if (pending.type === 'cancel') {
        throw new PlanError('E_INPUT', `order already cancelled in txn: ${orderId}`);
      }
      return pending.order;
    }
    const committed = this.#committed(orderId);
    if (!committed) throw new PlanError('E_INPUT', `unknown order: ${orderId}`);
    return committed;
  }

  adjust(txnId, orderId, patch) {
    const t = this.#txn(txnId);
    const base = this.#baseFor(t, orderId);
    const next = {
      id: orderId,
      workcenter: patch.workcenter ?? base.workcenter,
      start: patch.start ?? base.start,
      end: patch.end ?? base.end,
      qty: patch.qty ?? base.qty,
    };
    if (!Number.isInteger(next.qty) || next.qty <= 0) throw new PlanError('E_INPUT', 'qty must be a positive integer');
    if (!(next.start < next.end)) throw new PlanError('E_INPUT', 'start must be before end');
    const pending = t.ops.get(orderId);
    if (pending && pending.type === 'insert') {
      t.ops.set(orderId, { type: 'insert', order: next });
    } else {
      t.ops.set(orderId, { type: 'adjust', order: next, base });
    }
    return { ok: true, order: next };
  }

  cancel(txnId, orderId) {
    const t = this.#txn(txnId);
    const base = this.#baseFor(t, orderId);
    const pending = t.ops.get(orderId);
    if (pending && pending.type === 'insert') {
      t.ops.delete(orderId); // inserted and cancelled in the same txn: no-op
    } else {
      t.ops.set(orderId, { type: 'cancel', base });
    }
    return { ok: true };
  }

  commit(txnId) {
    const t = this.#txn(txnId);

    // 1) Re-validate every read predicate against the latest committed state.
    for (const p of t.predicates.values()) {
      const current = this.index.enumerate(p.workcenter, p.start, p.end);
      if (JSON.stringify(current) !== JSON.stringify(p.occupancy)) {
        this.txns.delete(txnId);
        throw new PlanError('E_SNAPSHOT',
          `predicate changed since snapshot on (${p.workcenter}, ${p.start}, ${p.end})`,
          { predicate: { workcenter: p.workcenter, start: p.start, end: p.end }, expected: p.occupancy, current });
      }
    }

    // 2) Write-write conflicts: adjusted/cancelled orders must not have been
    //    committed by another txn after our snapshot.
    for (const op of t.ops.values()) {
      if (op.type === 'adjust' || op.type === 'cancel') {
        const vs = this.orders.get(op.base.id);
        const last = vs[vs.length - 1];
        if (last.commitSeq > t.snapshot) {
          this.txns.delete(txnId);
          throw new PlanError('E_SNAPSHOT', `order modified concurrently: ${op.base.id}`);
        }
        if (op.type === 'adjust' && last.op === 'del') {
          this.txns.delete(txnId);
          throw new PlanError('E_SNAPSHOT', `order cancelled concurrently: ${op.base.id}`);
        }
      }
    }

    // 3) Capacity check on latest committed state plus this txn's deltas.
    const deltas = this.#pendingDeltas(t);
    for (const [wc, slots] of deltas) {
      for (const [slot, delta] of slots) {
        if (delta <= 0) continue;
        const used = this.index.quantityAt(wc, slot);
        const cap = this.capacityAt(wc, slot);
        if (used + delta > cap) {
          this.txns.delete(txnId);
          throw new PlanError('E_CAPACITY',
            `capacity exceeded on (${wc}, slot ${slot}): ${used}+${delta} > ${cap}`,
            { workcenter: wc, slot, used, delta, capacity: cap });
        }
      }
    }

    // 4) Apply.
    this.seq += 1;
    const commitSeq = this.seq;
    for (const op of t.ops.values()) {
      if (op.type === 'insert') {
        this.#appendVersion(op.order.id, commitSeq, 'put', op.order);
        this.index.apply(op.order.workcenter, op.order.start, op.order.end, op.order.qty);
      } else if (op.type === 'adjust') {
        this.#appendVersion(op.order.id, commitSeq, 'put', op.order);
        this.index.apply(op.base.workcenter, op.base.start, op.base.end, -op.base.qty);
        this.index.apply(op.order.workcenter, op.order.start, op.order.end, op.order.qty);
      } else if (op.type === 'cancel') {
        this.#appendVersion(op.base.id, commitSeq, 'del', null);
        this.index.apply(op.base.workcenter, op.base.start, op.base.end, -op.base.qty);
      }
    }
    this.txns.delete(txnId);

    const predicates = [...t.predicates.values()].map((p) => ({
      workcenter: p.workcenter,
      start: p.start,
      end: p.end,
      hash: hashPredicate(p),
    }));
    return {
      txn: txnId,
      commitSeq,
      committedAt: new Date().toISOString(),
      predicates,
      predicatesHash: hashPredicate(predicates),
    };
  }

  #appendVersion(orderId, commitSeq, op, order) {
    let vs = this.orders.get(orderId);
    if (!vs) {
      vs = [];
      this.orders.set(orderId, vs);
    }
    vs.push({ commitSeq, op, order });
  }

  abort(txnId) {
    this.#txn(txnId);
    this.txns.delete(txnId);
    return { ok: true };
  }
}
