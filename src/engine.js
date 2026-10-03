// Incremental cross-border settlement quota engine.
//
// Events (JSONL, one object per line):
//   {"type":"account","budget":N,"worstRates":{"USD":2,...}}   (at most once)
//   {"type":"payment","id":"p1","amount":100,"ccy":"USD","rate":null,"rateTs":0}
//   {"type":"quote","paymentId":"p1","rate":1.5,"ts":1}
//   {"type":"freeze","paymentId":"p1"}
//   {"type":"reverse","paymentId":"p1"}
//
// Semantics:
// - rate === null means "pending quote". A pending payment is NOT unsatisfiable;
//   it can be frozen, reserving a worst-case estimate amount * worstRates[ccy]
//   (default worst rate 1 when the currency is not configured).
// - Risk budget aggregates confirmed exposure (frozen, rate known) plus
//   pending worst-case upper bounds (frozen, rate null). A freeze that would
//   push the aggregate over budget fails with E_BUDGET.
// - A quote must carry a strictly newer ts than the payment's current rateTs,
//   otherwise E_RATE_STALE. When a quote arrives for a frozen payment, the
//   reservation is re-evaluated against the budget with the actual rate: the
//   payment turns eligible (patch "add") or, if the actual exposure no longer
//   fits, rejected (its freeze is rolled back; patch "remove" if it was eligible).
// - reverse releases the reservation and frees budget (patch "remove" if eligible).
// - eligibleSet changes are emitted as patches: {seq, event, op: "add"|"remove", id}.

export const EPS = 1e-9;

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export function worstRateFor(worstRates, ccy) {
  const r = worstRates[ccy];
  return typeof r === 'number' && Number.isFinite(r) ? r : 1;
}

export function createEngine() {
  const payments = new Map();
  const eligible = new Set();
  let hasAccount = false;
  let budget = Infinity;
  let worstRates = Object.create(null);
  let confirmed = 0;   // confirmed exposure: frozen, rate known, not rejected
  let pendingWorst = 0; // worst-case upper bound: frozen, rate null, not rejected
  let seq = 0;
  const patches = [];

  function emit(eventIndex, op, id) {
    seq += 1;
    patches.push({ seq, event: eventIndex, op, id });
  }

  function getPayment(id) {
    const p = payments.get(id);
    if (!p) throw new EngineError('E_UNKNOWN_PAYMENT', `unknown payment: ${id}`);
    return p;
  }

  function reservationOf(p) {
    return p.amount * (p.rate === null ? worstRateFor(worstRates, p.ccy) : p.rate);
  }

  function addBucket(p, r) {
    if (p.rate === null) pendingWorst += r; else confirmed += r;
  }

  function releaseBucket(p) {
    const r = reservationOf(p);
    if (p.rate === null) pendingWorst -= r; else confirmed -= r;
  }

  function fits(extra) {
    return confirmed + pendingWorst + extra <= budget + EPS;
  }

  function apply(event, eventIndex) {
    patches.length = 0;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new EngineError('E_EVENT', `event ${eventIndex}: not an object`);
    }
    switch (event.type) {
      case 'account': {
        if (hasAccount) {
          throw new EngineError('E_ACCOUNT_REDEFINED', 'account already configured');
        }
        if (typeof event.budget !== 'number' || !Number.isFinite(event.budget) || event.budget < 0) {
          throw new EngineError('E_EVENT', 'account.budget must be a non-negative finite number');
        }
        hasAccount = true;
        budget = event.budget;
        worstRates = Object.assign(Object.create(null), event.worstRates || {});
        break;
      }
      case 'payment': {
        const { id, amount, ccy } = event;
        if (typeof id !== 'string' || id === '') {
          throw new EngineError('E_EVENT', 'payment.id must be a non-empty string');
        }
        if (payments.has(id)) {
          throw new EngineError('E_DUP_PAYMENT', `payment already defined: ${id}`);
        }
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
          throw new EngineError('E_EVENT', `payment ${id}: amount must be a non-negative finite number`);
        }
        const rate = event.rate === null || event.rate === undefined ? null : event.rate;
        if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) {
          throw new EngineError('E_EVENT', `payment ${id}: rate must be null or a non-negative finite number`);
        }
        const rateTs = event.rateTs ?? 0;
        payments.set(id, { id, amount, ccy, rate, rateTs, frozen: false, rejected: false });
        break;
      }
      case 'quote': {
        const p = getPayment(event.paymentId);
        if (p.rejected) break; // rejected is terminal
        if (typeof event.rate !== 'number' || !Number.isFinite(event.rate) || event.rate < 0) {
          throw new EngineError('E_EVENT', `quote for ${p.id}: rate must be a non-negative finite number`);
        }
        const ts = event.ts ?? 0;
        if (ts <= p.rateTs) {
          throw new EngineError('E_RATE_STALE',
            `quote for ${p.id}: ts=${ts} not newer than current rateTs=${p.rateTs}`);
        }
        const wasFrozen = p.frozen;
        if (wasFrozen) releaseBucket(p); // uses old rate / worst-case bucket
        p.rate = event.rate;
        p.rateTs = ts;
        if (wasFrozen) {
          const r = reservationOf(p);
          if (fits(r)) {
            addBucket(p, r);
            if (!eligible.has(p.id)) {
              eligible.add(p.id);
              emit(eventIndex, 'add', p.id);
            }
          } else {
            // Actual exposure exceeds budget: reject and roll back the freeze.
            p.frozen = false;
            p.rejected = true;
            if (eligible.has(p.id)) {
              eligible.delete(p.id);
              emit(eventIndex, 'remove', p.id);
            }
          }
        }
        break;
      }
      case 'freeze': {
        const p = getPayment(event.paymentId);
        if (p.frozen || p.rejected) break; // idempotent no-op
        const r = reservationOf(p);
        if (!fits(r)) {
          throw new EngineError('E_BUDGET',
            `freeze ${p.id}: exposure ${confirmed + pendingWorst + r} would exceed budget ${budget}`);
        }
        p.frozen = true;
        addBucket(p, r);
        if (p.rate !== null && !eligible.has(p.id)) {
          eligible.add(p.id);
          emit(eventIndex, 'add', p.id);
        }
        break;
      }
      case 'reverse': {
        const p = getPayment(event.paymentId);
        if (!p.frozen) break; // idempotent no-op
        releaseBucket(p);
        p.frozen = false;
        if (eligible.has(p.id)) {
          eligible.delete(p.id);
          emit(eventIndex, 'remove', p.id);
        }
        break;
      }
      default:
        throw new EngineError('E_EVENT', `unknown event type: ${event.type}`);
    }
    return patches.slice();
  }

  return {
    apply,
    eligibleSet() {
      return [...eligible].sort();
    },
    exposure() {
      return { confirmed, pendingWorst, total: confirmed + pendingWorst, budget };
    },
  };
}
