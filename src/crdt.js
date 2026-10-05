import { createHash } from 'node:crypto';

export class NegativeCountError extends Error {
  constructor(event) {
    super(`negative count delta in event ${event?.id ?? '<unknown>'}: ${event?.delta}`);
    this.name = 'NegativeCountError';
    this.code = 'ERR_NEGATIVE_COUNT';
  }
}

export class InvalidEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidEventError';
    this.code = 'ERR_INVALID_EVENT';
  }
}

export const COUNT_KEYS = ['produced', 'rejected'];

export function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new InvalidEventError('event must be an object');
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    throw new InvalidEventError('event must have a non-empty string id');
  }
  switch (event.type) {
    case 'count': {
      if (!COUNT_KEYS.includes(event.key)) {
        throw new InvalidEventError(`count event ${event.id} has unknown key: ${event.key}`);
      }
      if (typeof event.delta !== 'number' || !Number.isFinite(event.delta)) {
        throw new InvalidEventError(`count event ${event.id} has non-numeric delta`);
      }
      if (event.delta < 0) {
        throw new NegativeCountError(event);
      }
      break;
    }
    case 'down': {
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new InvalidEventError(`down event ${event.id} has unparseable start/end`);
      }
      if (end < start) {
        throw new InvalidEventError(`down event ${event.id} ends before it starts`);
      }
      break;
    }
    case 'undo': {
      if (typeof event.target !== 'string' || event.target.length === 0) {
        throw new InvalidEventError(`undo event ${event.id} must name a target id`);
      }
      break;
    }
    default:
      throw new InvalidEventError(`unknown event type: ${event.type}`);
  }
  return event;
}

/**
 * CvRDT-style event store. State-based merge is set-union keyed by event id,
 * which makes merge idempotent, commutative and associative by construction.
 *
 * - produced/rejected are G-Counters (per-terminal grow-only sums of unique
 *   deltas); their difference is a PN-Counter.
 * - downtime intervals are an add-wins set; undo events are tombstones
 *   (remove-wins, tombstones are never removed).
 */
export class Store {
  constructor(events = []) {
    this.events = new Map();
    for (const event of events) this.add(event);
  }

  add(event) {
    validateEvent(event);
    if (!this.events.has(event.id)) {
      this.events.set(event.id, event);
    }
    return this;
  }

  merge(other) {
    for (const event of other.events.values()) this.add(event);
    return this;
  }

  static mergeAll(stores) {
    const out = new Store();
    for (const store of stores) out.merge(store);
    return out;
  }

  ids() {
    return [...this.events.keys()].sort();
  }

  /** Anti-entropy digest: hash over the sorted event-id set. */
  digest() {
    const ids = this.ids();
    const hash = createHash('sha256').update(ids.join('\n')).digest('hex');
    return { count: ids.length, hash };
  }

  /** Ids present in this store but missing from other (anti-entropy delta). */
  missingFrom(other) {
    return this.ids().filter((id) => !other.events.has(id));
  }

  /** Canonical serialization: events sorted by id, one JSON per line. */
  toJSONL() {
    return this.ids()
      .map((id) => JSON.stringify(this.events.get(id)))
      .join('\n') + '\n';
  }

  equals(other) {
    return this.toJSONL() === other.toJSONL();
  }

  gCounter(key) {
    const perTerminal = new Map();
    for (const event of this.events.values()) {
      if (event.type !== 'count' || event.key !== key) continue;
      const terminal = event.terminal ?? 'default';
      perTerminal.set(terminal, (perTerminal.get(terminal) ?? 0) + event.delta);
    }
    return perTerminal;
  }

  gCounterValue(key) {
    let total = 0;
    for (const value of this.gCounter(key).values()) total += value;
    return total;
  }

  produced() {
    return this.gCounterValue('produced');
  }

  rejected() {
    return this.gCounterValue('rejected');
  }

  /** PN-Counter: produced G-Counter minus rejected G-Counter. */
  netCount() {
    return this.produced() - this.rejected();
  }

  tombstones() {
    const targets = new Set();
    for (const event of this.events.values()) {
      if (event.type === 'undo') targets.add(event.target);
    }
    return targets;
  }

  /** Downtime intervals that are not tombstoned. */
  liveDowntimes() {
    const dead = this.tombstones();
    const out = [];
    for (const event of this.events.values()) {
      if (event.type === 'down' && !dead.has(event.id)) {
        out.push({ id: event.id, start: Date.parse(event.start), end: Date.parse(event.end) });
      }
    }
    return out;
  }

  /** Overlapping/adjacent downtime intervals merged into disjoint coverage. */
  mergedDowntimeIntervals() {
    const sorted = this.liveDowntimes().sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (last && interval.start <= last.end) {
        last.end = Math.max(last.end, interval.end);
      } else {
        merged.push({ start: interval.start, end: interval.end });
      }
    }
    return merged;
  }
}

export function parseJSONL(text) {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new InvalidEventError(`line ${i + 1}: invalid JSON`);
    }
    events.push(validateEvent(event));
  }
  return events;
}
