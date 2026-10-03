// Independent reference implementation used by the enumeration test (D).
// Unlike the incremental engine, it keeps no running aggregates: every budget
// check recomputes total exposure from scratch by scanning all payments, and
// patches are derived by diffing the eligible set before/after each event.
import { EngineError, EPS, worstRateFor } from './engine.js';

export function runReference(events) {
  const payments = new Map();
  const eligible = new Set();
  const patches = [];
  let hasAccount = false;
  let budget = Infinity;
  let worstRates = Object.create(null);
  let seq = 0;

  function aggregateFromScratch() {
    let total = 0;
    for (const p of payments.values()) {
      if (!p.frozen || p.rejected) continue;
      total += p.amount * (p.rate === null ? worstRateFor(worstRates, p.ccy) : p.rate);
    }
    return total;
  }

  function reservationOf(p) {
    return p.amount * (p.rate === null ? worstRateFor(worstRates, p.ccy) : p.rate);
  }

  function getPayment(id) {
    const p = payments.get(id);
    if (!p) throw new EngineError('E_UNKNOWN_PAYMENT', `unknown payment: ${id}`);
    return p;
  }

  function diffEligible(before, eventIndex) {
    for (const id of before) {
      if (!eligible.has(id)) {
        seq += 1;
        patches.push({ seq, event: eventIndex, op: 'remove', id });
      }
    }
    for (const id of eligible) {
      if (!before.has(id)) {
        seq += 1;
        patches.push({ seq, event: eventIndex, op: 'add', id });
      }
    }
  }

  events.forEach((event, i) => {
    const eventIndex = i + 1;
    const before = new Set(eligible);
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new EngineError('E_EVENT', `event ${eventIndex}: not an object`);
    }
    switch (event.type) {
      case 'account': {
        if (hasAccount) throw new EngineError('E_ACCOUNT_REDEFINED', 'account already configured');
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
        if (payments.has(id)) throw new EngineError('E_DUP_PAYMENT', `payment already defined: ${id}`);
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
          throw new EngineError('E_EVENT', `payment ${id}: amount must be a non-negative finite number`);
        }
        const rate = event.rate === null || event.rate === undefined ? null : event.rate;
        if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) {
          throw new EngineError('E_EVENT', `payment ${id}: rate must be null or a non-negative finite number`);
        }
        payments.set(id, { id, amount, ccy, rate, rateTs: event.rateTs ?? 0, frozen: false, rejected: false });
        break;
      }
      case 'quote': {
        const p = getPayment(event.paymentId);
        if (p.rejected) break;
        if (typeof event.rate !== 'number' || !Number.isFinite(event.rate) || event.rate < 0) {
          throw new EngineError('E_EVENT', `quote for ${p.id}: rate must be a non-negative finite number`);
        }
        const ts = event.ts ?? 0;
        if (ts <= p.rateTs) {
          throw new EngineError('E_RATE_STALE',
            `quote for ${p.id}: ts=${ts} not newer than current rateTs=${p.rateTs}`);
        }
        // Unfreeze, recompute the aggregate from scratch without this payment,
        // then decide with the actual rate.
        const wasFrozen = p.frozen;
        if (wasFrozen) p.frozen = false;
        p.rate = event.rate;
        p.rateTs = ts;
        if (wasFrozen) {
          const r = reservationOf(p);
          if (aggregateFromScratch() + r <= budget + EPS) {
            p.frozen = true;
            eligible.add(p.id);
          } else {
            p.rejected = true;
            eligible.delete(p.id);
          }
        }
        break;
      }
      case 'freeze': {
        const p = getPayment(event.paymentId);
        if (p.frozen || p.rejected) break;
        const r = reservationOf(p);
        if (aggregateFromScratch() + r > budget + EPS) {
          throw new EngineError('E_BUDGET',
            `freeze ${p.id}: exposure ${aggregateFromScratch() + r} would exceed budget ${budget}`);
        }
        p.frozen = true;
        if (p.rate !== null) eligible.add(p.id);
        break;
      }
      case 'reverse': {
        const p = getPayment(event.paymentId);
        if (!p.frozen) break;
        p.frozen = false;
        eligible.delete(p.id);
        break;
      }
      default:
        throw new EngineError('E_EVENT', `unknown event type: ${event.type}`);
    }
    diffEligible(before, eventIndex);
  });

  return { eligible: [...eligible].sort(), patches };
}
