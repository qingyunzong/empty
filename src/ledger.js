import { CardError, E } from './errors.js';
import { TRANSITIONS } from './stateMachine.js';
import { Stats } from './stats.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function reqString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new CardError(E.VALIDATION, `field "${field}" must be a non-empty string`);
  }
  return value;
}

function reqDay(value, field) {
  reqString(value, field);
  if (!DAY_RE.test(value)) {
    throw new CardError(E.VALIDATION, `field "${field}" must be a YYYY-MM-DD day, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optAmount(value, field) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CardError(E.VALIDATION, `field "${field}" must be null or a non-negative finite number`);
  }
  return value;
}

function optCurrency(value) {
  if (value == null) return null;
  return reqString(value, 'currency');
}

export class Ledger {
  constructor() {
    this.transactions = new Map(); // id -> tx
    this.captures = []; // append-only capture log (source of truth for stats)
    this.settlements = new Map(); // merchant -> max settled day (string)
    this.stats = new Stats();
  }

  apply(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new CardError(E.VALIDATION, 'event must be an object');
    }
    reqString(event.type, 'type');
    switch (event.type) {
      case 'auth': return this.#auth(event);
      case 'capture': return this.#capture(event);
      case 'void': return this.#simple(event, 'void');
      case 'refund': return this.#simple(event, 'refund');
      case 'chargeback': return this.#simple(event, 'chargeback');
      case 'reverse_refund': return this.#reverseRefund(event);
      case 'reverse_chargeback': return this.#reverseChargeback(event);
      case 'settle': return this.#settle(event);
      default:
        throw new CardError(E.VALIDATION, `unknown event type ${JSON.stringify(event.type)}`);
    }
  }

  merchantStats(merchant, day) {
    return this.stats.get(merchant, day);
  }

  // Rebuild materialized stats for a merchant from a given day forward.
  recomputeStats(merchant, fromDay) {
    reqDay(fromDay, 'fromDay');
    this.stats.recompute(merchant, fromDay, this.captures);
  }

  isSettlementLocked(tx) {
    const settledDay = this.settlements.get(tx.merchant);
    return settledDay != null && tx.captureDay != null && settledDay >= tx.captureDay;
  }

  #getTx(id) {
    reqString(id, 'id');
    const tx = this.transactions.get(id);
    if (!tx) throw new CardError(E.NOT_FOUND, `unknown transaction id ${JSON.stringify(id)}`);
    return tx;
  }

  #nextState(tx, eventType) {
    const next = TRANSITIONS[tx.state]?.[eventType];
    if (!next) {
      throw new CardError(
        E.TRANSITION,
        `cannot apply ${eventType} to transaction ${tx.id} in state ${tx.state}`,
      );
    }
    return next;
  }

  #auth(event) {
    const id = reqString(event.id, 'id');
    if (this.transactions.has(id)) {
      throw new CardError(E.DUPLICATE, `transaction ${JSON.stringify(id)} already exists`);
    }
    const tx = {
      id,
      merchant: reqString(event.merchant, 'merchant'),
      state: 'auth',
      authDay: reqDay(event.day, 'day'),
      amount: optAmount(event.amount, 'amount'),
      currency: optCurrency(event.currency),
      tip: optAmount(event.tip, 'tip'),
      captureDay: null,
      refundReversed: false,
    };
    this.transactions.set(id, tx);
    return tx;
  }

  #capture(event) {
    const tx = this.#getTx(event.id);
    tx.state = this.#nextState(tx, 'capture');
    const day = reqDay(event.day, 'day');
    if (event.amount !== undefined) tx.amount = optAmount(event.amount, 'amount');
    if (event.tip !== undefined) tx.tip = optAmount(event.tip, 'tip');
    tx.captureDay = day;
    const effective = tx.amount == null ? null : tx.amount + (tx.tip ?? 0);
    const rec = {
      id: tx.id,
      merchant: tx.merchant,
      day,
      currency: tx.currency,
      amount: tx.amount,
      tip: tx.tip,
      effective,
    };
    this.captures.push(rec);
    this.stats.addCapture(rec);
    return tx;
  }

  #simple(event, eventType) {
    const tx = this.#getTx(event.id);
    tx.state = this.#nextState(tx, eventType);
    return tx;
  }

  #reverseRefund(event) {
    const tx = this.#getTx(event.id);
    const next = this.#nextState(tx, 'reverse_refund');
    if (tx.refundReversed) {
      throw new CardError(E.TRANSITION, `refund of transaction ${tx.id} was already reversed once`);
    }
    tx.refundReversed = true;
    tx.state = next;
    return tx;
  }

  #reverseChargeback(event) {
    const tx = this.#getTx(event.id);
    const next = this.#nextState(tx, 'reverse_chargeback');
    // Lock boundary: a capture is locked iff the merchant has a settlement
    // whose day is >= the capture day. Check before any mutation.
    if (this.isSettlementLocked(tx)) {
      throw new CardError(
        E.LOCKED,
        `capture of transaction ${tx.id} (day ${tx.captureDay}) is locked by settlement`,
      );
    }
    tx.state = next;
    return tx;
  }

  #settle(event) {
    const merchant = reqString(event.merchant, 'merchant');
    const day = reqDay(event.day, 'day');
    const current = this.settlements.get(merchant);
    if (current == null || day > current) this.settlements.set(merchant, day);
    return { merchant, settledDay: this.settlements.get(merchant) };
  }
}
