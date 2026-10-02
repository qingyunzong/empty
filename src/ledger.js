import { createHash } from 'node:crypto';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// Deterministic JSON serialization: object keys sorted recursively.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Content hash of an event over its causal payload (prev sorted for determinism).
export function hashEvent(event) {
  const body = {
    type: event.type,
    paymentId: event.paymentId,
    amount: event.amount,
    clock: event.clock,
    prev: [...event.prev].sort(),
  };
  return sha256(canonical(body));
}

// true iff every component of a is <= the corresponding component of b.
export function clockLE(a, b) {
  for (const k of Object.keys(a)) if ((b[k] ?? 0) < a[k]) return false;
  return true;
}

function byHash(x, y) {
  return x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0;
}

export class Ledger {
  constructor(replica) {
    if (!replica || typeof replica !== 'string') {
      throw new LedgerError('usage', 'a string replica id is required');
    }
    this.replica = replica;
    this.events = new Map(); // hash -> event
    this.frontier = []; // hashes of events with no known children
    this.clock = {}; // merged vector clock
  }

  static fromJSON(data) {
    const ledger = new Ledger(data.replica);
    for (const e of data.events ?? []) ledger.events.set(e.hash, e);
    ledger.frontier = [...(data.frontier ?? [])];
    ledger.clock = { ...(data.clock ?? {}) };
    return ledger;
  }

  toJSON() {
    return {
      replica: this.replica,
      clock: { ...this.clock },
      frontier: [...this.frontier].sort(),
      events: [...this.events.values()].sort(byHash),
    };
  }

  // Create and apply a local event. prev = current frontier (hash chain),
  // clock = merged clock with own component incremented.
  append({ type, paymentId, amount }) {
    if (type !== 'settle' && type !== 'adjust') {
      throw new LedgerError('usage', 'type must be "settle" or "adjust"');
    }
    if (!paymentId || typeof paymentId !== 'string') {
      throw new LedgerError('usage', 'paymentId must be a non-empty string');
    }
    if (!Number.isFinite(amount)) {
      throw new LedgerError('usage', 'amount must be a finite number');
    }
    const clock = { ...this.clock };
    clock[this.replica] = (clock[this.replica] ?? 0) + 1;
    const event = { type, paymentId, amount, clock, prev: [...this.frontier].sort() };
    event.hash = hashEvent(event);
    this.#apply(event);
    return event;
  }

  #apply(event) {
    this.events.set(event.hash, event);
    const prevSet = new Set(event.prev);
    this.frontier = this.frontier.filter((h) => !prevSet.has(h));
    this.frontier.push(event.hash);
    this.frontier.sort();
    for (const [k, v] of Object.entries(event.clock)) {
      this.clock[k] = Math.max(this.clock[k] ?? 0, v);
    }
  }

  // Incremental, atomic merge of external events (array of event objects).
  // Already-known events are skipped. Returns hashes of newly applied events.
  // Throws LedgerError('unknown-predecessor' | 'stale-clock' | 'bad-hash').
  merge(incoming) {
    if (!Array.isArray(incoming)) throw new LedgerError('usage', 'merge expects an array');
    const work = Ledger.fromJSON(this.toJSON());
    const applied = work.#mergeInPlace(incoming);
    this.events = work.events;
    this.frontier = work.frontier;
    this.clock = work.clock;
    return applied;
  }

  #mergeInPlace(incoming) {
    const pending = new Map();
    for (const e of incoming) {
      if (!e || typeof e !== 'object' || !Array.isArray(e.prev) || !e.clock) {
        throw new LedgerError('bad-hash', 'malformed event');
      }
      if (hashEvent(e) !== e.hash) {
        throw new LedgerError('bad-hash', `event hash mismatch: ${e.hash}`);
      }
      pending.set(e.hash, e);
    }
    const applied = [];
    while (pending.size > 0) {
      let progressed = false;
      for (const [hash, event] of [...pending]) {
        if (this.events.has(hash)) {
          pending.delete(hash);
          progressed = true;
          continue;
        }
        if (!event.prev.every((p) => this.events.has(p))) continue; // wait for parents
        if (clockLE(event.clock, this.clock)) {
          throw new LedgerError('stale-clock', `event ${hash} clock regresses`);
        }
        this.#apply(event);
        applied.push(hash);
        pending.delete(hash);
        progressed = true;
      }
      if (!progressed) {
        const missing = [...pending.values()][0].prev.find(
          (p) => !this.events.has(p) && !pending.has(p),
        );
        throw new LedgerError('unknown-predecessor', `missing predecessor ${missing}`);
      }
    }
    return applied;
  }

  // Derived state: per-payment balances and conflicts.
  // An event asserts the full new balance of its payment. Causally ordered
  // events resolve to the latest assertion; concurrent events with different
  // amounts are a conflict and are never silently resolved.
  computeState() {
    const byPayment = new Map();
    for (const e of this.events.values()) {
      if (!byPayment.has(e.paymentId)) byPayment.set(e.paymentId, []);
      byPayment.get(e.paymentId).push(e);
    }
    const balances = {};
    const conflicts = {};
    for (const [pid, evs] of [...byPayment.entries()].sort()) {
      const involved = new Map();
      for (let i = 0; i < evs.length; i++) {
        for (let j = i + 1; j < evs.length; j++) {
          const a = evs[i];
          const b = evs[j];
          const concurrent = !clockLE(a.clock, b.clock) && !clockLE(b.clock, a.clock);
          if (concurrent && a.amount !== b.amount) {
            involved.set(a.hash, a);
            involved.set(b.hash, b);
          }
        }
      }
      if (involved.size > 0) {
        conflicts[pid] = [...involved.values()]
          .sort(byHash)
          .map((e) => ({ hash: e.hash, amount: e.amount }));
        continue;
      }
      const maximal = evs.filter(
        (e) => !evs.some((o) => o.hash !== e.hash && clockLE(e.clock, o.clock)),
      );
      balances[pid] = maximal[0].amount;
    }
    return { balances, conflicts };
  }

  // Finality certificate; only issued when all references are present and
  // no payment is in conflict.
  certificate() {
    for (const e of this.events.values()) {
      for (const p of e.prev) {
        if (!this.events.has(p)) {
          throw new LedgerError('unknown-predecessor', `missing predecessor ${p}`);
        }
      }
    }
    const { balances, conflicts } = this.computeState();
    if (Object.keys(conflicts).length > 0) {
      throw new LedgerError('conflict', `conflicting payments: ${Object.keys(conflicts).join(',')}`);
    }
    const entries = [...this.events.values()].sort(byHash);
    return {
      frontier: [...this.frontier].sort(),
      entriesHash: sha256(canonical(entries)),
      balances,
    };
  }
}
