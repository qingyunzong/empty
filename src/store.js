// Event store: applies the append-only input stream (events, corrections via
// `replaces`, retractions via `retracts`) to a deterministic current-state
// view. Shared by the incremental engine and the naive full-replay reference
// so both observe identical store semantics.
//
// Idempotency rules:
//   - a record whose own `id` was already seen is a no-op (duplicate delivery)
//   - replaces/retracts of an already-removed (tombstoned) id are no-ops
//   - replaces/retracts of a never-seen id are domain errors; the offending
//     record has no effect and processing continues deterministically

export function normalizeTime(time) {
  if (typeof time === 'number' && Number.isFinite(time)) return time;
  if (typeof time === 'string') {
    const ms = Date.parse(time);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

export class EventStore {
  constructor() {
    this.events = new Map(); // id -> { id, time, device, type, value, seq }
    this.seen = new Set(); // every id ever accepted (events and retractions)
    this.tombstoned = new Set(); // ids removed by replaces/retracts
    this.errors = [];
  }

  // Applies one input record. seq is the 1-based event sequence number.
  // Returns { affected: Set<device>, reason } or null when the record is a
  // no-op or was rejected (error recorded in this.errors).
  apply(record, seq) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      this.errors.push({ seq, error: 'record must be a JSON object' });
      return null;
    }

    if (record.id !== undefined && this.seen.has(record.id)) {
      return null; // duplicate delivery: idempotent no-op
    }

    if (record.retracts !== undefined) {
      if (record.id !== undefined) this.seen.add(record.id);
      const target = record.retracts;
      const old = this.events.get(target);
      if (!old) {
        if (this.tombstoned.has(target)) return null; // already gone: idempotent
        this.errors.push({ seq, error: `unknown event id '${target}' in retracts` });
        return null;
      }
      this.events.delete(target);
      this.tombstoned.add(target);
      return { affected: new Set([old.device]), reason: 'retracted', time: normalizeTime(record.time) ?? old.time };
    }

    const time = normalizeTime(record.time);
    if (typeof record.id !== 'string' || record.id === '') {
      this.errors.push({ seq, error: 'event requires a non-empty string id' });
      return null;
    }
    if (time === null) {
      this.errors.push({ seq, error: `event '${record.id}' has missing or invalid time` });
      return null;
    }
    if (typeof record.device !== 'string' || record.device === '') {
      this.errors.push({ seq, error: `event '${record.id}' requires a device` });
      return null;
    }
    if (typeof record.type !== 'string' || record.type === '') {
      this.errors.push({ seq, error: `event '${record.id}' requires a type` });
      return null;
    }
    if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
      this.errors.push({ seq, error: `event '${record.id}' requires a numeric value` });
      return null;
    }

    this.seen.add(record.id);
    const affected = new Set();
    let reason = 'recovered';
    if (record.replaces !== undefined) {
      const target = record.replaces;
      const old = this.events.get(target);
      if (!old) {
        if (!this.tombstoned.has(target)) {
          this.errors.push({ seq, error: `unknown event id '${target}' in replaces` });
          return null; // rejected: no effect on the store
        }
        // target already replaced/retracted: accept the new reading on its own
      } else {
        this.events.delete(target);
        this.tombstoned.add(target);
        affected.add(old.device);
      }
      reason = 'corrected';
    }

    this.events.set(record.id, {
      id: record.id,
      time,
      device: record.device,
      type: record.type,
      value: record.value,
      seq,
    });
    affected.add(record.device);
    return { affected, reason, time };
  }

  // Events of one device ordered by (time, arrival seq): the replay window.
  eventsFor(device) {
    const list = [];
    for (const ev of this.events.values()) {
      if (ev.device === device) list.push(ev);
    }
    list.sort((a, b) => a.time - b.time || a.seq - b.seq);
    return list;
  }

  devices() {
    const set = new Set();
    for (const ev of this.events.values()) set.add(ev.device);
    return [...set].sort();
  }
}
