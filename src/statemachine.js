import { createHash } from 'node:crypto';

export const STATES = Object.freeze({
  NEW: 'NEW',
  CANCELED: 'CANCELED',
  MATCHED: 'MATCHED',
  CONFLICT: 'CONFLICT',
});

export const GENESIS_HASH = '0'.repeat(64);

export class SmError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function hashEvent(event) {
  const { hash, ...rest } = event;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

// Returns -1 (a<b), 0 (equal), 1 (a>b), null (concurrent).
export function compareClocks(a, b) {
  let less = false;
  let greater = false;
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    const x = (a && a[key]) || 0;
    const y = (b && b[key]) || 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  if (less && greater) return null;
  if (less) return -1;
  if (greater) return 1;
  return 0;
}

function dominates(a, b) {
  const rel = compareClocks(a, b);
  return rel === 1 || rel === 0;
}

function clockSum(clock) {
  return Object.values(clock || {}).reduce((acc, v) => acc + v, 0);
}

// Causally minimal events; deterministic tiebreak by eventId.
function causalMin(events) {
  if (events.length === 0) return null;
  const minima = events.filter(
    (e) => !events.some((o) => o !== e && compareClocks(o.clock, e.clock) === -1),
  );
  minima.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  return minima[0];
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const d = clockSum(a.clock) - clockSum(b.clock);
    if (d !== 0) return d;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
}

// Deterministically reduce an event set to an order view.
// Concurrent cancel/match are BOTH kept and yield CONFLICT; never a coin flip.
export function reduceOrder(orderId, events) {
  const byId = new Map();
  for (const event of events) {
    if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  }
  const all = sortEvents([...byId.values()]);
  const cancels = all.filter((e) => e.type === 'cancel');
  const matches = all.filter((e) => e.type === 'match');
  const resolves = all.filter((e) => e.type === 'resolve');

  const cancel = causalMin(cancels);
  const match = causalMin(matches);
  const rejected = [];
  let state = STATES.NEW;
  let conflict = null;

  if (cancel && match) {
    const rel = compareClocks(cancel.clock, match.clock);
    if (rel === -1 || (rel === 0 && cancel.eventId < match.eventId)) {
      state = STATES.CANCELED;
      rejected.push({ eventId: match.eventId, reason: 'already-canceled' });
    } else if (rel === 1 || rel === 0) {
      state = STATES.MATCHED;
      rejected.push({ eventId: cancel.eventId, reason: 'already-matched' });
    } else {
      state = STATES.CONFLICT;
      conflict = { cancel, match };
    }
  } else if (cancel) {
    state = STATES.CANCELED;
  } else if (match) {
    state = STATES.MATCHED;
  }

  for (const extra of cancels) {
    if (cancel && extra !== cancel) rejected.push({ eventId: extra.eventId, reason: 'superseded-cancel' });
  }
  for (const extra of matches) {
    if (match && extra !== match) rejected.push({ eventId: extra.eventId, reason: 'superseded-match' });
  }

  let resolution = null;
  if (conflict) {
    // A resolution is valid only if its author had observed BOTH conflicting events.
    const valid = resolves.filter(
      (r) =>
        (r.to === STATES.CANCELED || r.to === STATES.MATCHED) &&
        dominates(r.clock, conflict.cancel.clock) &&
        dominates(r.clock, conflict.match.clock),
    );
    resolution = causalMin(valid);
    if (resolution) state = resolution.to;
  }

  return { orderId, state, events: all, cancel, match, conflict, resolution, rejected };
}

export class Replica {
  constructor(replicaId, data) {
    this.data = data || { replicaId: replicaId || 'replica-1', orders: {} };
    this.replicaId = this.data.replicaId;
  }

  static fromJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    return new Replica(data.replicaId, data);
  }

  toJSON() {
    return this.data;
  }

  createOrder(orderId) {
    if (this.data.orders[orderId]) throw new SmError('already-exists', `order ${orderId} exists`);
    this.data.orders[orderId] = { events: [] };
    return this.getOrder(orderId);
  }

  getOrder(orderId) {
    const order = this.data.orders[orderId];
    if (!order) throw new SmError('not-found', `order ${orderId} not found`);
    return reduceOrder(orderId, order.events);
  }

  listOrders() {
    return Object.keys(this.data.orders).sort().map((id) => this.getOrder(id));
  }

  issue(orderId, type, extra, eventId) {
    const order = this.data.orders[orderId];
    if (!order) throw new SmError('not-found', `order ${orderId} not found`);
    const clock = {};
    for (const e of order.events) {
      for (const [k, v] of Object.entries(e.clock)) clock[k] = Math.max(clock[k] || 0, v);
    }
    clock[this.replicaId] = (clock[this.replicaId] || 0) + 1;
    const prevHash = order.events.length
      ? hashEvent(order.events[order.events.length - 1])
      : GENESIS_HASH;
    const id = eventId || `${this.replicaId}-${clock[this.replicaId]}`;
    if (order.events.some((e) => e.eventId === id)) {
      throw new SmError('duplicate-event', `event ${id} already exists`);
    }
    const event = {
      type,
      orderId,
      eventId: id,
      replicaId: this.replicaId,
      prevHash,
      clock,
      ...(extra || {}),
    };
    order.events.push(event);
    return event;
  }

  cancel(orderId, eventId) {
    const view = this.getOrder(orderId);
    if (view.state === STATES.CANCELED) throw new SmError('already-canceled');
    if (view.state === STATES.MATCHED) throw new SmError('already-matched');
    if (view.state === STATES.CONFLICT) throw new SmError('conflict-unresolved');
    const event = this.issue(orderId, 'cancel', null, eventId);
    return { event, view: this.getOrder(orderId) };
  }

  match(orderId, eventId) {
    const view = this.getOrder(orderId);
    if (view.state === STATES.CANCELED) throw new SmError('already-canceled');
    if (view.state === STATES.MATCHED) throw new SmError('already-matched');
    if (view.state === STATES.CONFLICT) throw new SmError('conflict-unresolved');
    const event = this.issue(orderId, 'match', null, eventId);
    return { event, view: this.getOrder(orderId) };
  }

  resolve(orderId, to, reason, eventId) {
    const view = this.getOrder(orderId);
    if (view.state !== STATES.CONFLICT) throw new SmError('no-conflict');
    if (to !== STATES.CANCELED && to !== STATES.MATCHED) throw new SmError('invalid-target');
    const event = this.issue(orderId, 'resolve', { to, reason: reason || '' }, eventId);
    return { event, view: this.getOrder(orderId) };
  }

  merge(other) {
    const otherData = other instanceof Replica ? other.toJSON() : other;
    for (const [orderId, order] of Object.entries(otherData.orders || {})) {
      if (!this.data.orders[orderId]) {
        this.data.orders[orderId] = { events: order.events.map((e) => ({ ...e, clock: { ...e.clock } })) };
        continue;
      }
      const local = this.data.orders[orderId];
      const known = new Set(local.events.map((e) => e.eventId));
      for (const event of order.events) {
        if (!known.has(event.eventId)) {
          local.events.push({ ...event, clock: { ...event.clock } });
          known.add(event.eventId);
        }
      }
    }
    return this;
  }

  certificate(orderId) {
    const view = this.getOrder(orderId);
    const events = view.events.map((e) => ({ ...e, hash: hashEvent(e) }));
    const cert = {
      orderId,
      replicaId: this.replicaId,
      state: view.state,
      valid: view.state !== STATES.CONFLICT,
      events,
      rejected: view.rejected,
      conflict: null,
      resolution: null,
    };
    if (view.conflict) {
      cert.conflict = {
        cancelEventId: view.conflict.cancel.eventId,
        matchEventId: view.conflict.match.eventId,
        cancelHash: hashEvent(view.conflict.cancel),
        matchHash: hashEvent(view.conflict.match),
      };
    }
    if (view.resolution) {
      cert.resolution = {
        eventId: view.resolution.eventId,
        to: view.resolution.to,
        reason: view.resolution.reason || '',
        basis: {
          cancelEventId: view.conflict.cancel.eventId,
          matchEventId: view.conflict.match.eventId,
          cancelHash: hashEvent(view.conflict.cancel),
          matchHash: hashEvent(view.conflict.match),
        },
      };
    }
    return cert;
  }
}
