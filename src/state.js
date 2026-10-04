import { GateError, EXIT } from './errors.js';
import { effectivePermission } from './config.js';

// Tie-break rank at equal (ts, priority): freeze beats release.
const TYPE_RANK = { release: 0, freeze: 1 };

// Deterministic resolution order: timestamp, then priority (higher wins),
// then type (freeze wins ties), then seq (last writer wins).
export function compareDecisionEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pa - pb;
  const ra = TYPE_RANK[a.type];
  const rb = TYPE_RANK[b.type];
  if (ra !== rb) return ra - rb;
  return a.seq - b.seq;
}

export function createState(idx) {
  const stock = {};
  for (const [m, spec] of Object.entries(idx.materials)) stock[m] = spec.stock;
  const orders = {};
  for (const id of idx.orders.keys()) {
    orders[id] = {
      decision: 'none',
      decisionEvent: null,
      scheduledTo: null,
      locks: {},
      candidates: [],
    };
  }
  return {
    seq: 0,
    lastTs: null,
    stock,
    orders,
    revoked: {},
    bySeq: {},
    compensations: [],
    breaches: [],
  };
}

export function applyEvent(state, event, idx) {
  // Normalize a defensive copy; caller-owned event objects are never mutated.
  const seq = event.seq ?? state.seq + 1;
  const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : event.ts;
  if (!Number.isFinite(ts)) {
    throw new GateError(`event ${seq}: invalid ts`, EXIT.USAGE);
  }
  event = { ...event, seq, ts };
  if (event.type === 'reschedule' && typeof event.to === 'string') {
    event.to = Date.parse(event.to);
    if (!Number.isFinite(event.to)) {
      throw new GateError(`event ${seq}: invalid to`, EXIT.USAGE);
    }
  }
  if (state.lastTs !== null && event.ts < state.lastTs) {
    throw new GateError(
      `event ${event.seq}: timestamp goes backwards`,
      EXIT.TIME_BACKWARDS,
    );
  }
  state.lastTs = event.ts;
  state.seq = event.seq;
  switch (event.type) {
    case 'release':
    case 'freeze': {
      const order = state.orders[event.order];
      if (!order) {
        state.breaches.push({ seq: event.seq, order: event.order, reason: 'unknown-order' });
        return state;
      }
      order.candidates.push({
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        priority: event.priority ?? 0,
      });
      state.bySeq[event.seq] = { type: event.type, order: event.order };
      resolveOrder(state, idx, event.order, event.seq);
      return state;
    }
    case 'revoke': {
      const target = state.bySeq[event.target];
      if (event.actor !== 'supervisor' || !target || target.type !== 'freeze') {
        state.breaches.push({
          seq: event.seq,
          reason: 'invalid-revoke',
          target: event.target,
          actor: event.actor,
        });
        return state;
      }
      state.revoked[event.target] = event.seq;
      resolveOrder(state, idx, target.order, event.seq);
      return state;
    }
    case 'reschedule': {
      const order = state.orders[event.order];
      if (!order) {
        state.breaches.push({ seq: event.seq, order: event.order, reason: 'unknown-order' });
        return state;
      }
      if (event.to < event.ts) {
        throw new GateError(
          `event ${event.seq}: reschedule target is in the past`,
          EXIT.TIME_BACKWARDS,
        );
      }
      order.scheduledTo = event.to;
      return state;
    }
    default:
      throw new GateError(`event ${event.seq}: unsupported type`, EXIT.USAGE);
  }
}

function resolveOrder(state, idx, orderId, causeSeq) {
  const order = state.orders[orderId];
  let winner = null;
  for (const cand of order.candidates) {
    if (state.revoked[cand.seq]) continue;
    if (!winner || compareDecisionEvents(cand, winner) > 0) winner = cand;
  }
  order.decision = winner ? (winner.type === 'freeze' ? 'frozen' : 'released') : 'none';
  order.decisionEvent = winner;

  const wantLocks =
    order.decision === 'released' && effectivePermission(idx, orderId) === 'allow';
  const held = Object.keys(order.locks).length > 0;
  if (wantLocks && !held) {
    const spec = idx.orders.get(orderId);
    const mats = spec.materials;
    const ok = Object.entries(mats).every(([m, q]) => (state.stock[m] ?? 0) >= q);
    if (ok) {
      for (const [m, q] of Object.entries(mats)) state.stock[m] -= q;
      order.locks = { ...mats };
    } else {
      state.breaches.push({ seq: causeSeq, order: orderId, reason: 'material-shortage' });
    }
  } else if (!wantLocks && held) {
    // A release that already consumed material locks is being overridden.
    // History is not rewritten: a compensation event is emitted instead.
    for (const [m, q] of Object.entries(order.locks)) state.stock[m] += q;
    state.compensations.push({
      seq: `C${state.compensations.length + 1}`,
      type: 'compensate',
      order: orderId,
      restores: { ...order.locks },
      cause: causeSeq,
      ts: state.lastTs,
    });
    order.locks = {};
  }
}

export function foldEvents(events, idx, state = createState(idx)) {
  for (const event of events) applyEvent(state, event, idx);
  return state;
}
