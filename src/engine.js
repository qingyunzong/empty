// Incremental bitemporal engine.
//
// Events are immutable and append-only; a correction is a new event with the
// same (equipment, valid_time) and a later tx_time. Visibility is decided by
// tx_time (never by arrival order): among events sharing a valid_time, the
// effective one is the one with the greatest tx_time (arrival seq breaks
// ties). AS OF queries filter on tx_time, so a view taken at an old
// transaction time can never be changed by later retroactive corrections.

import { parseTime } from './validate.js';

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const keyOf = (equipment, validMs) => `${equipment} ${validMs}`;

// Does event `a` supersede event `b` at the same valid_time?
function beats(a, b) {
  return a.txMs > b.txMs || (a.txMs === b.txMs && a.seq > b.seq);
}

export function diffCounts(before, after) {
  const deltas = [];
  const equipments = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const equipment of [...equipments].sort()) {
    const days = new Set([
      ...Object.keys(before[equipment] ?? {}),
      ...Object.keys(after[equipment] ?? {}),
    ]);
    for (const day of [...days].sort()) {
      const b = before[equipment]?.[day] ?? { up: 0, down: 0 };
      const a = after[equipment]?.[day] ?? { up: 0, down: 0 };
      const up = a.up - b.up;
      const down = a.down - b.down;
      if (up !== 0 || down !== 0) deltas.push({ equipment, date: day, up, down });
    }
  }
  return deltas;
}

export class Engine {
  constructor() {
    this.events = []; // internal events in arrival (seq) order, incl. undone
    this.seq = 0;
    this.undoneTx = new Set();
    this.effective = new Map(); // key -> currently effective internal event
    this.counts = new Map(); // equipment -> Map(day -> {up, down})
    this.txDeltas = new Map(); // tx_id -> deltas produced when it committed
  }

  toInternal(raw) {
    return {
      id: raw.id,
      equipment: raw.equipment,
      validMs: parseTime(raw.valid_time, 'valid_time'),
      state: raw.state,
      txId: raw.tx_id,
      txMs: parseTime(raw.tx_time, 'tx_time'),
      seq: this.seq++,
    };
  }

  bumpCount(equipment, day, state, amount) {
    let byDay = this.counts.get(equipment);
    if (!byDay) {
      byDay = new Map();
      this.counts.set(equipment, byDay);
    }
    const entry = byDay.get(day) ?? { up: 0, down: 0 };
    entry[state] += amount;
    byDay.set(day, entry);
  }

  addDelta(deltaMap, equipment, day, state, amount) {
    const key = keyOf(equipment, day);
    let delta = deltaMap.get(key);
    if (!delta) {
      delta = { equipment, date: day, up: 0, down: 0 };
      deltaMap.set(key, delta);
    }
    delta[state] += amount;
  }

  // Apply a committed batch record; returns the per-day up/down deltas.
  applyBatch(record) {
    const deltaMap = new Map();
    for (const raw of record.events) {
      const event = this.toInternal(raw);
      this.events.push(event);
      const key = keyOf(event.equipment, event.validMs);
      const current = this.effective.get(key);
      if (!current || beats(event, current)) {
        const day = dayOf(event.validMs);
        if (current) {
          this.bumpCount(current.equipment, day, current.state, -1);
          this.addDelta(deltaMap, current.equipment, day, current.state, -1);
        }
        this.effective.set(key, event);
        this.bumpCount(event.equipment, day, event.state, +1);
        this.addDelta(deltaMap, event.equipment, day, event.state, +1);
      }
      // A late-arriving event whose tx_time loses to the current effective
      // event is kept for history but changes no counts.
    }
    const deltas = [...deltaMap.values()]
      .filter((d) => d.up !== 0 || d.down !== 0)
      .sort((a, b) => a.equipment.localeCompare(b.equipment) || a.date.localeCompare(b.date));
    this.txDeltas.set(record.tx_id, deltas);
    return deltas;
  }

  assertUndoable(txId) {
    if (!this.txDeltas.has(txId)) throw new Error(`unknown tx_id: ${txId}`);
    if (this.undoneTx.has(txId)) throw new Error(`tx_id already undone: ${txId}`);
  }

  // Undo a transaction: its events leave the current view, and both the
  // snapshot (counts) and the emitted deltas reflect the removal. Counts are
  // rebuilt from the remaining active events so supersession chains stay
  // correct; the returned delta is the exact before/after difference.
  undo(txId) {
    this.assertUndoable(txId);
    const before = this.countsSnapshot();
    this.undoneTx.add(txId);
    this.rebuild();
    return diffCounts(before, this.countsSnapshot());
  }

  rebuild() {
    this.effective = new Map();
    this.counts = new Map();
    for (const event of this.events) {
      if (this.undoneTx.has(event.txId)) continue;
      const key = keyOf(event.equipment, event.validMs);
      const current = this.effective.get(key);
      if (!current || beats(event, current)) {
        const day = dayOf(event.validMs);
        if (current) this.bumpCount(current.equipment, day, current.state, -1);
        this.effective.set(key, event);
        this.bumpCount(event.equipment, day, event.state, +1);
      }
    }
  }

  // State of `equipment` at valid time `validMs`, as known at transaction
  // time `txMs` (Infinity = current view).
  asOf(equipment, validMs, txMs = Infinity) {
    let best = null;
    for (const event of this.events) {
      if (event.equipment !== equipment) continue;
      if (this.undoneTx.has(event.txId)) continue;
      if (event.txMs > txMs || event.validMs > validMs) continue;
      if (
        !best ||
        event.validMs > best.validMs ||
        (event.validMs === best.validMs &&
          (event.txMs > best.txMs || (event.txMs === best.txMs && event.seq > best.seq)))
      ) {
        best = event;
      }
    }
    return best ? best.state : null;
  }

  countsSnapshot() {
    const out = {};
    for (const [equipment, byDay] of [...this.counts.entries()].sort()) {
      const days = {};
      for (const [day, entry] of [...byDay.entries()].sort()) {
        if (entry.up !== 0 || entry.down !== 0) days[day] = { ...entry };
      }
      if (Object.keys(days).length > 0) out[equipment] = days;
    }
    return out;
  }

  serialize() {
    return {
      seq: this.seq,
      events: this.events,
      undoneTx: [...this.undoneTx],
      txDeltas: Object.fromEntries(this.txDeltas),
    };
  }

  load(snapshot) {
    this.events = snapshot.events ?? [];
    this.seq = snapshot.seq ?? this.events.length;
    this.undoneTx = new Set(snapshot.undoneTx ?? []);
    this.txDeltas = new Map(Object.entries(snapshot.txDeltas ?? {}));
    this.rebuild();
  }
}
