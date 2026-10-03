import { createHash } from 'node:crypto';

export const ERRORS = {
  LIMIT_EXCEEDED: 'limit-exceeded',
  OVER_RELEASE: 'over-release',
  CONFLICT: 'conflict',
  UNKNOWN_RESERVATION: 'unknown-reservation',
  INVALID_EVENT: 'invalid-event',
};

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function createReplica(limit) {
  if (!Number.isFinite(limit) || limit < 0) throw new Error('invalid limit');
  return { limit, events: {}, reservations: {} };
}

export function activeReserved(state) {
  let total = 0;
  for (const r of Object.values(state.reservations)) total += r.amount - r.released;
  return total;
}

export function balance(state) {
  const reserved = activeReserved(state);
  return { limit: state.limit, reserved, available: state.limit - reserved };
}

function isPositiveAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'reserve') {
    if (typeof event.requestId !== 'string' || event.requestId === '') return null;
    if (typeof event.account !== 'string' || !isPositiveAmount(event.amount)) return null;
    return { type: 'reserve', requestId: event.requestId, account: event.account, amount: event.amount };
  }
  if (event.type === 'release') {
    if (typeof event.requestId !== 'string' || event.requestId === '') return null;
    if (typeof event.reservationId !== 'string' || !isPositiveAmount(event.amount)) return null;
    return { type: 'release', requestId: event.requestId, reservationId: event.reservationId, amount: event.amount };
  }
  return null;
}

function fail(error) {
  return { ok: false, error };
}

export function applyEvent(state, rawEvent, { enforceLimit = true } = {}) {
  const event = normalizeEvent(rawEvent);
  if (!event) return fail(ERRORS.INVALID_EVENT);

  const existing = state.events[event.requestId];
  if (existing) {
    // Idempotent replay: identical payload is a no-op, divergent payload is rejected.
    return canonical(existing) === canonical(event)
      ? { ok: true, changed: false }
      : fail(ERRORS.CONFLICT);
  }

  if (event.type === 'reserve') {
    if (enforceLimit && event.amount > state.limit - activeReserved(state)) {
      return fail(ERRORS.LIMIT_EXCEEDED);
    }
    state.events[event.requestId] = event;
    state.reservations[event.requestId] = {
      requestId: event.requestId,
      account: event.account,
      amount: event.amount,
      released: 0,
      status: 'active',
    };
    return { ok: true, changed: true };
  }

  const reservation = state.reservations[event.reservationId];
  if (!reservation) return fail(ERRORS.UNKNOWN_RESERVATION);
  const remaining = reservation.amount - reservation.released;
  if (event.amount > remaining) return fail(ERRORS.OVER_RELEASE);
  state.events[event.requestId] = event;
  reservation.released += event.amount;
  if (reservation.released >= reservation.amount) {
    // Fully released: keep the record as a tombstone so stale releases
    // and replayed reservations cannot resurrect it.
    reservation.status = 'released';
  }
  return { ok: true, changed: true };
}

export function summary(state) {
  const eventIds = Object.keys(state.events).sort();
  const digest = createHash('sha256')
    .update(canonical(eventIds.map((id) => state.events[id])))
    .digest('hex');
  return { limit: state.limit, digest, eventIds };
}

// Events this replica has that the peer (described by its summary) is missing.
export function diff(state, peerSummary) {
  const theirs = new Set(peerSummary.eventIds);
  return Object.keys(state.events)
    .filter((id) => !theirs.has(id))
    .sort()
    .map((id) => state.events[id]);
}

export function merge(state, events) {
  if (!Array.isArray(events)) return fail(ERRORS.INVALID_EVENT);
  const normalized = events.map(normalizeEvent);
  if (normalized.some((e) => e === null)) return fail(ERRORS.INVALID_EVENT);

  for (const event of normalized) {
    const existing = state.events[event.requestId];
    if (existing && canonical(existing) !== canonical(event)) return fail(ERRORS.CONFLICT);
  }

  // Reservations first so releases can find them. The limit is not enforced
  // during merge: concurrent reservations from other replicas must still
  // consume quota locally.
  const ordered = [...normalized].sort((a, b) => {
    if (a.type === b.type) return 0;
    return a.type === 'reserve' ? -1 : 1;
  });
  let changed = false;
  for (const event of ordered) {
    const result = applyEvent(state, event, { enforceLimit: false });
    if (!result.ok) return result;
    changed = changed || result.changed;
  }
  return { ok: true, changed };
}
