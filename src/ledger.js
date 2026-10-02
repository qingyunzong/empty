import { createHash, randomUUID } from 'node:crypto';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const EVENT_TYPES = new Set(['trade', 'cancel', 'restore']);

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

export function hashEvent(event) {
  const body = {
    id: event.id,
    type: event.type,
    tradeId: event.tradeId,
    prev: [...event.prev].sort(),
    observes: event.observes ?? null,
  };
  return createHash('sha256').update(canonical(body)).digest('hex');
}

function validateShape(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new LedgerError('invalid-event', 'event must be an object');
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    throw new LedgerError('invalid-event', 'event.id must be a non-empty string');
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new LedgerError('invalid-event', 'event.type must be trade|cancel|restore');
  }
  if (typeof event.tradeId !== 'string' || event.tradeId.length === 0) {
    throw new LedgerError('invalid-event', 'event.tradeId must be a non-empty string');
  }
  if (!Array.isArray(event.prev) || event.prev.some((p) => typeof p !== 'string')) {
    throw new LedgerError('invalid-event', 'event.prev must be an array of hashes');
  }
  if (event.type === 'trade') {
    if (event.observes !== null && event.observes !== undefined) {
      throw new LedgerError('invalid-event', 'trade event must not observe anything');
    }
  } else if (typeof event.observes !== 'string' || event.observes.length === 0) {
    throw new LedgerError('invalid-event', `${event.type} event must carry an observes hash`);
  }
}

export class Ledger {
  #events = new Map(); // hash -> event
  #ids = new Map();    // event id -> hash

  constructor(events = []) {
    if (events.length > 0) this.merge(events);
  }

  get size() {
    return this.#events.size;
  }

  has(hash) {
    return this.#events.has(hash);
  }

  events() {
    return [...this.#events.values()]
      .map((e) => ({ ...e, prev: [...e.prev] }))
      .sort((a, b) => (a.hash < b.hash ? -1 : 1));
  }

  heads() {
    const referenced = new Set();
    for (const event of this.#events.values()) {
      for (const p of event.prev) referenced.add(p);
      if (event.observes) referenced.add(event.observes);
    }
    return [...this.#events.keys()].filter((h) => !referenced.has(h)).sort();
  }

  add(event) {
    return this.merge([event]);
  }

  merge(events) {
    if (!Array.isArray(events)) {
      throw new LedgerError('invalid-events', 'merge expects an array of events');
    }
    const union = new Map(this.#events);
    const ids = new Map(this.#ids);
    let added = 0;
    let duplicates = 0;

    for (const raw of events) {
      validateShape(raw);
      const hash = hashEvent(raw);
      if (raw.hash !== hash) {
        throw new LedgerError('invalid-hash', `event ${raw.id} has a mismatched hash`);
      }
      if (union.has(hash)) {
        duplicates += 1; // idempotent replay of an already known event
        continue;
      }
      if (ids.has(raw.id)) {
        throw new LedgerError('duplicate-event-id', `event id ${raw.id} reused with different content`);
      }
      const stored = { ...raw, prev: [...raw.prev].sort(), observes: raw.observes ?? null, hash };
      union.set(hash, stored);
      ids.set(raw.id, hash);
      added += 1;
    }

    // Referential integrity over the union, so events inside one merge may
    // arrive in any causal order.
    const tradesById = new Map();
    for (const event of union.values()) {
      if (event.type === 'trade') {
        const existing = tradesById.get(event.tradeId);
        if (existing && existing.hash !== event.hash) {
          throw new LedgerError('duplicate-trade', `trade ${event.tradeId} already exists`);
        }
        tradesById.set(event.tradeId, event);
      }
    }
    for (const event of union.values()) {
      if (event.type === 'cancel') {
        const target = union.get(event.observes);
        if (!target || target.type !== 'trade' || target.tradeId !== event.tradeId) {
          throw new LedgerError('unknown-trade', `cancel ${event.id} does not observe a known trade`);
        }
      } else if (event.type === 'restore') {
        const target = union.get(event.observes);
        if (!target || target.type !== 'cancel' || target.tradeId !== event.tradeId) {
          throw new LedgerError('restore-without-cancel', `restore ${event.id} does not observe a cancel`);
        }
      }
    }

    this.#events = union;
    this.#ids = ids;
    return { added, duplicates };
  }

  #ancestors(startHash) {
    const seen = new Set();
    const stack = [startHash];
    while (stack.length > 0) {
      const hash = stack.pop();
      const event = this.#events.get(hash);
      if (!event) continue;
      const deps = event.observes ? [...event.prev, event.observes] : event.prev;
      for (const dep of deps) {
        if (!seen.has(dep)) {
          seen.add(dep);
          stack.push(dep);
        }
      }
    }
    return seen; // strict causal past of startHash
  }

  #byType(type, tradeId) {
    return [...this.#events.values()]
      .filter((e) => e.type === type && e.tradeId === tradeId);
  }

  getState(tradeId) {
    if (![...this.#events.values()].some((e) => e.type === 'trade' && e.tradeId === tradeId)) {
      throw new LedgerError('unknown-trade', `unknown trade ${tradeId}`);
    }
    const cancels = this.#byType('cancel', tradeId);
    const restores = this.#byType('restore', tradeId);
    const ancestorCache = new Map();
    const ancestorsOf = (hash) => {
      if (!ancestorCache.has(hash)) ancestorCache.set(hash, this.#ancestors(hash));
      return ancestorCache.get(hash);
    };

    let conflict = false;
    let tombstone = false;
    for (const cancel of cancels) {
      let cleared = false;
      for (const restore of restores) {
        const cancelBeforeRestore = ancestorsOf(restore.hash).has(cancel.hash);
        const restoreBeforeCancel = ancestorsOf(cancel.hash).has(restore.hash);
        if (cancelBeforeRestore) {
          cleared = true; // restore causally after this cancel clears its tombstone
        } else if (!restoreBeforeCancel) {
          conflict = true; // concurrent cancel and restore, neither observes the other
        }
      }
      if (!cleared) tombstone = true; // concurrent cancels collapse into one tombstone
    }

    const status = conflict ? 'conflict' : tombstone ? 'cancelled' : 'active';
    return {
      tradeId,
      status,
      tombstone,
      cancels: cancels.length,
      restores: restores.length,
    };
  }

  tombstones() {
    const tradeIds = new Set(
      [...this.#events.values()].filter((e) => e.type === 'trade').map((e) => e.tradeId),
    );
    return [...tradeIds].filter((id) => this.getState(id).tombstone).sort();
  }

  createTrade(tradeId) {
    if ([...this.#events.values()].some((e) => e.type === 'trade' && e.tradeId === tradeId)) {
      throw new LedgerError('duplicate-trade', `trade ${tradeId} already exists`);
    }
    return this.#createEvent('trade', tradeId, null);
  }

  createCancel(tradeId) {
    const trade = [...this.#events.values()]
      .find((e) => e.type === 'trade' && e.tradeId === tradeId);
    if (!trade) {
      throw new LedgerError('unknown-trade', `unknown trade ${tradeId}`);
    }
    return this.#createEvent('cancel', tradeId, trade.hash);
  }

  createRestore(tradeId) {
    if (![...this.#events.values()].some((e) => e.type === 'trade' && e.tradeId === tradeId)) {
      throw new LedgerError('unknown-trade', `unknown trade ${tradeId}`);
    }
    const cancels = this.#byType('cancel', tradeId);
    if (cancels.length === 0) {
      throw new LedgerError('restore-without-cancel', `trade ${tradeId} has no observed cancel`);
    }
    const observes = cancels.map((c) => c.hash).sort().at(-1);
    return this.#createEvent('restore', tradeId, observes);
  }

  #createEvent(type, tradeId, observes) {
    const event = {
      id: randomUUID(),
      type,
      tradeId,
      prev: this.heads(),
      observes,
    };
    event.hash = hashEvent(event);
    this.add(event);
    return { ...event, prev: [...event.prev] };
  }
}
