import { createHash } from 'node:crypto';

export const SLOT_MINUTES = 15;
const INF = Number.POSITIVE_INFINITY;

export function predicateKey(workcenter, start, end) {
  return `${workcenter}|${start}|${end}`;
}

export function predicateHash(predicate) {
  return createHash('sha256')
    .update(`${predicate.workcenter}|${predicate.start}|${predicate.end}|${predicate.value}`)
    .digest('hex');
}

function assertInterval(workcenter, start, end) {
  if (typeof workcenter !== 'string' || workcenter.length === 0) {
    throw new TypeError('workcenter must be a non-empty string');
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end) {
    throw new RangeError(`invalid slot interval [${start}, ${end})`);
  }
}

function assertQty(qty) {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new RangeError(`qty must be a positive integer, got ${qty}`);
  }
}

// Naive reference implementation: scan every version visible at `seq` and sum
// qty * overlapSlots for the predicate interval. Used to cross-check the index.
export function naiveOccupancy(versions, seq, workcenter, start, end) {
  let total = 0;
  for (const v of versions) {
    if (v.workcenter !== workcenter) continue;
    if (!(v.beginSeq <= seq && seq < v.endSeq)) continue;
    const overlap = Math.min(v.end, end) - Math.max(v.start, start);
    if (overlap > 0) total += v.qty * overlap;
  }
  return total;
}

// Secondary predicate index organized by (workcenter, start, end).
// Each entry caches the predicate value at the latest committed state plus a
// delta log, so the value at any historical snapshot seq can be reconstructed.
// Entries registered lazily replay the database-wide committed delta log so
// snapshots taken before registration still read correctly.
export class PredicateIndex {
  constructor(db) {
    this.db = db;
    this.entries = new Map();
  }

  ensure(workcenter, start, end) {
    const key = predicateKey(workcenter, start, end);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { workcenter, start, end, value: 0, deltas: [] };
      for (const change of this.db.deltaLog) {
        if (change.workcenter !== workcenter) continue;
        const overlap = Math.min(end, change.end) - Math.max(start, change.start);
        if (overlap <= 0) continue;
        const delta = change.deltaQty * overlap;
        entry.value += delta;
        entry.deltas.push({ seq: change.seq, delta });
      }
      this.entries.set(key, entry);
    }
    return entry;
  }

  valueAt(workcenter, start, end, seq) {
    const entry = this.ensure(workcenter, start, end);
    let value = entry.value;
    for (let i = entry.deltas.length - 1; i >= 0 && entry.deltas[i].seq > seq; i--) {
      value -= entry.deltas[i].delta;
    }
    return value;
  }

  applyDelta(workcenter, start, end, deltaQty, seq) {
    for (const entry of this.entries.values()) {
      if (entry.workcenter !== workcenter) continue;
      const overlap = Math.min(entry.end, end) - Math.max(entry.start, start);
      if (overlap <= 0) continue;
      const delta = deltaQty * overlap;
      entry.value += delta;
      entry.deltas.push({ seq, delta });
    }
  }
}

export class Database {
  constructor() {
    this.versions = [];              // all committed versions (MVCC history)
    this.live = new Map();           // orderId -> live committed version
    this.slotLoad = new Map();       // workcenter -> Map(slot -> qty) at latest committed state
    this.capacity = new Map();       // workcenter -> Map(slot -> integer capacity)
    this.deltaLog = [];              // committed {seq, workcenter, start, end, deltaQty}
    this.commitSeq = 0;              // logical commit clock
    this.txCounter = 0;
    this.index = new PredicateIndex(this);
  }

  setCapacity(workcenter, slot, capacity) {
    if (typeof workcenter !== 'string' || workcenter.length === 0) {
      throw new TypeError('workcenter must be a non-empty string');
    }
    if (!Number.isInteger(slot) || slot < 0) {
      throw new RangeError(`slot must be a non-negative integer, got ${slot}`);
    }
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`capacity must be a non-negative integer, got ${capacity}`);
    }
    let perWorkcenter = this.capacity.get(workcenter);
    if (!perWorkcenter) {
      perWorkcenter = new Map();
      this.capacity.set(workcenter, perWorkcenter);
    }
    perWorkcenter.set(slot, capacity);
  }

  getCapacity(workcenter, slot) {
    return this.capacity.get(workcenter)?.get(slot) ?? 0;
  }

  slotOccupancy(workcenter, slot) {
    return this.slotLoad.get(workcenter)?.get(slot) ?? 0;
  }

  slotSum(workcenter, start, end) {
    let total = 0;
    for (let slot = start; slot < end; slot++) {
      total += this.slotOccupancy(workcenter, slot);
    }
    return total;
  }

  begin() {
    return new Transaction(this, ++this.txCounter, this.commitSeq);
  }

  addSlotLoad(workcenter, start, end, deltaQty) {
    let perWorkcenter = this.slotLoad.get(workcenter);
    if (!perWorkcenter) {
      perWorkcenter = new Map();
      this.slotLoad.set(workcenter, perWorkcenter);
    }
    for (let slot = start; slot < end; slot++) {
      perWorkcenter.set(slot, (perWorkcenter.get(slot) ?? 0) + deltaQty);
    }
  }

  commit(tx) {
    if (tx.state !== 'open') {
      throw new Error(`transaction ${tx.id} is not open (state=${tx.state})`);
    }
    const txId = `tx-${tx.id}`;

    // 1. Re-validate every predicate this transaction read against the LATEST
    //    committed state. If any value moved since the snapshot, abort.
    for (const predicate of tx.readPredicates.values()) {
      const latest = this.index.valueAt(predicate.workcenter, predicate.start, predicate.end, this.commitSeq);
      if (latest !== predicate.value) {
        tx.state = 'aborted';
        return {
          ok: false,
          error: 'E_SNAPSHOT',
          txId,
          detail: {
            workcenter: predicate.workcenter,
            start: predicate.start,
            end: predicate.end,
            expected: predicate.value,
            actual: latest,
          },
        };
      }
    }

    // 2. Resolve the resulting state of every order touched by this tx.
    const touched = new Set();
    const next = new Map();
    const currentOf = (orderId) =>
      touched.has(orderId) ? next.get(orderId) : (this.live.get(orderId) ?? null);

    for (const op of tx.ops) {
      if (op.op === 'insert') {
        if (currentOf(op.order)) {
          tx.state = 'aborted';
          return { ok: false, error: 'E_ORDER_EXISTS', txId, detail: { order: op.order } };
        }
        next.set(op.order, {
          workcenter: op.workcenter,
          start: op.start,
          end: op.end,
          qty: op.qty,
        });
      } else if (op.op === 'adjust') {
        const current = currentOf(op.order);
        if (!current) {
          tx.state = 'aborted';
          return { ok: false, error: 'E_NO_ORDER', txId, detail: { order: op.order } };
        }
        const adjusted = {
          workcenter: op.workcenter ?? current.workcenter,
          start: op.start ?? current.start,
          end: op.end ?? current.end,
          qty: op.qty ?? current.qty,
        };
        if (adjusted.start >= adjusted.end) {
          tx.state = 'aborted';
          return { ok: false, error: 'E_INVALID', txId, detail: { order: op.order, start: adjusted.start, end: adjusted.end } };
        }
        next.set(op.order, adjusted);
      } else if (op.op === 'cancel') {
        const current = currentOf(op.order);
        if (!current) {
          tx.state = 'aborted';
          return { ok: false, error: 'E_NO_ORDER', txId, detail: { order: op.order } };
        }
        next.set(op.order, null);
      }
      touched.add(op.order);
    }

    // 3. Capacity validation per (workcenter, slot) against latest committed
    //    load. Equal to capacity is allowed; exceeding by 1 is rejected.
    const deltas = new Map(); // workcenter -> Map(slot -> delta)
    const addDelta = (workcenter, slot, delta) => {
      let perWorkcenter = deltas.get(workcenter);
      if (!perWorkcenter) {
        perWorkcenter = new Map();
        deltas.set(workcenter, perWorkcenter);
      }
      perWorkcenter.set(slot, (perWorkcenter.get(slot) ?? 0) + delta);
    };
    for (const orderId of touched) {
      const before = this.live.get(orderId) ?? null;
      const after = next.get(orderId);
      if (before) {
        for (let slot = before.start; slot < before.end; slot++) addDelta(before.workcenter, slot, -before.qty);
      }
      if (after) {
        for (let slot = after.start; slot < after.end; slot++) addDelta(after.workcenter, slot, after.qty);
      }
    }
    for (const [workcenter, perSlot] of deltas) {
      for (const [slot, delta] of perSlot) {
        if (delta === 0) continue;
        const load = this.slotOccupancy(workcenter, slot) + delta;
        const capacity = this.getCapacity(workcenter, slot);
        if (load > capacity) {
          tx.state = 'aborted';
          return {
            ok: false,
            error: 'E_CAPACITY',
            txId,
            detail: { workcenter, slot, load, capacity },
          };
        }
      }
    }

    // 4. Apply: bump the commit clock, close old versions, open new ones,
    //    update slot load and the predicate index.
    const seq = ++this.commitSeq;
    for (const orderId of touched) {
      const before = this.live.get(orderId) ?? null;
      const after = next.get(orderId);
      if (before) {
        before.endSeq = seq;
        this.addSlotLoad(before.workcenter, before.start, before.end, -before.qty);
        this.deltaLog.push({ seq, workcenter: before.workcenter, start: before.start, end: before.end, deltaQty: -before.qty });
        this.index.applyDelta(before.workcenter, before.start, before.end, -before.qty, seq);
      }
      if (after) {
        const version = { orderId, ...after, beginSeq: seq, endSeq: INF };
        this.versions.push(version);
        this.live.set(orderId, version);
        this.addSlotLoad(after.workcenter, after.start, after.end, after.qty);
        this.deltaLog.push({ seq, workcenter: after.workcenter, start: after.start, end: after.end, deltaQty: after.qty });
        this.index.applyDelta(after.workcenter, after.start, after.end, after.qty, seq);
      } else {
        this.live.delete(orderId);
      }
    }

    tx.state = 'committed';
    const predicates = [...tx.readPredicates.values()].map((p) => ({ ...p, hash: predicateHash(p) }));
    return {
      ok: true,
      txId,
      commitSeq: seq,
      commitTimestamp: new Date().toISOString(),
      predicates,
      predicateHashes: predicates.map((p) => p.hash),
    };
  }
}

export class Transaction {
  constructor(db, id, snapshotSeq) {
    this.db = db;
    this.id = id;
    this.snapshotSeq = snapshotSeq;
    this.readPredicates = new Map();
    this.ops = [];
    this.state = 'open';
  }

  assertOpen() {
    if (this.state !== 'open') {
      throw new Error(`transaction ${this.id} is not open (state=${this.state})`);
    }
  }

  // Reads occupancy of (workcenter, [start, end)) at the transaction snapshot
  // and registers the predicate for commit-time re-validation.
  readOccupancy(workcenter, start, end) {
    this.assertOpen();
    assertInterval(workcenter, start, end);
    const value = this.db.index.valueAt(workcenter, start, end, this.snapshotSeq);
    this.readPredicates.set(predicateKey(workcenter, start, end), {
      workcenter,
      start,
      end,
      value,
    });
    return value;
  }

  // Remaining capacity = min over slots of (capacity - occupancy) at snapshot.
  // Registers the (workcenter, start, end) predicate for re-validation.
  readRemaining(workcenter, start, end) {
    this.assertOpen();
    this.readOccupancy(workcenter, start, end);
    let remaining = INF;
    for (let slot = start; slot < end; slot++) {
      const occupied = naiveOccupancy(this.db.versions, this.snapshotSeq, workcenter, slot, slot + 1);
      remaining = Math.min(remaining, this.db.getCapacity(workcenter, slot) - occupied);
    }
    return remaining;
  }

  insert({ order, workcenter, start, end, qty }) {
    this.assertOpen();
    if (typeof order !== 'string' || order.length === 0) {
      throw new TypeError('order must be a non-empty string');
    }
    assertInterval(workcenter, start, end);
    assertQty(qty);
    this.ops.push({ op: 'insert', order, workcenter, start, end, qty });
  }

  adjust({ order, workcenter, start, end, qty }) {
    this.assertOpen();
    if (typeof order !== 'string' || order.length === 0) {
      throw new TypeError('order must be a non-empty string');
    }
    if (workcenter !== undefined) {
      if (typeof workcenter !== 'string' || workcenter.length === 0) {
        throw new TypeError('workcenter must be a non-empty string');
      }
    }
    for (const [name, value] of [['start', start], ['end', end]]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
      }
    }
    if (start !== undefined && end !== undefined && start >= end) {
      throw new RangeError(`invalid slot interval [${start}, ${end})`);
    }
    if (qty !== undefined) assertQty(qty);
    this.ops.push({ op: 'adjust', order, workcenter, start, end, qty });
  }

  cancel({ order }) {
    this.assertOpen();
    if (typeof order !== 'string' || order.length === 0) {
      throw new TypeError('order must be a non-empty string');
    }
    this.ops.push({ op: 'cancel', order });
  }

  commit() {
    return this.db.commit(this);
  }

  abort() {
    this.assertOpen();
    this.state = 'aborted';
    return { ok: true, txId: `tx-${this.id}`, aborted: true };
  }
}
