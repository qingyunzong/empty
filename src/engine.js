import { hash as cryptoHash } from 'node:crypto';

export const ERRORS = Object.freeze({
  INSUFFICIENT: 'INSUFFICIENT',
  FROZEN: 'FROZEN',
  BAD_PARENT: 'BAD_PARENT',
  DUP_OP: 'DUP_OP',
  TIME_TRAVEL: 'TIME_TRAVEL',
});

export const STATUS = Object.freeze({
  APPLIED: 'APPLIED',
  IDEMPOTENT: 'IDEMPOTENT',
  ERROR: 'ERROR',
});

export const DEFAULT_TTL = 10;
export const OP_TYPES = Object.freeze(['deposit', 'authorize', 'confirm', 'capture', 'void', 'expire']);

const GENESIS = 'payment-ledger-v1-genesis';

function sha256(text) {
  return cryptoHash('sha256', text, 'hex');
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function isPosInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

const ALLOWED_FIELDS = Object.freeze({
  deposit: ['clientOpId', 'clock', 'type', 'amount'],
  authorize: ['clientOpId', 'clock', 'type', 'amount', 'ttl'],
  confirm: ['clientOpId', 'clock', 'type', 'parent'],
  capture: ['clientOpId', 'clock', 'type', 'parent', 'amount'],
  void: ['clientOpId', 'clock', 'type', 'parent', 'amount'],
  expire: ['clientOpId', 'clock', 'type', 'parent', 'slot', 'outcome'],
});

export function validateOp(op) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new TypeError('op must be a plain object');
  }
  if (typeof op.clientOpId !== 'string' || op.clientOpId.length === 0) {
    throw new TypeError('op.clientOpId must be a non-empty string');
  }
  if (!isNonNegInt(op.clock)) {
    throw new TypeError('op.clock must be a non-negative safe integer');
  }
  if (!OP_TYPES.includes(op.type)) {
    throw new TypeError(`unknown op type: ${String(op.type)}`);
  }
  for (const key of Object.keys(op)) {
    if (!ALLOWED_FIELDS[op.type].includes(key)) {
      throw new TypeError(`unexpected field "${key}" for op type "${op.type}"`);
    }
  }
  if (op.type === 'deposit' || op.type === 'authorize' || op.type === 'capture') {
    if (!isPosInt(op.amount)) throw new TypeError(`${op.type}.amount must be a positive safe integer`);
  }
  if (op.type === 'authorize' && op.ttl !== undefined && !isPosInt(op.ttl)) {
    throw new TypeError('authorize.ttl must be a positive safe integer');
  }
  if (op.type === 'confirm' || op.type === 'capture' || op.type === 'void' || op.type === 'expire') {
    if (typeof op.parent !== 'string' || op.parent.length === 0) {
      throw new TypeError(`${op.type}.parent must be a non-empty string`);
    }
  }
  if (op.type === 'void' && op.amount !== undefined && !isPosInt(op.amount)) {
    throw new TypeError('void.amount must be a positive safe integer');
  }
  if (op.type === 'expire') {
    if (!isNonNegInt(op.slot)) throw new TypeError('expire.slot must be a non-negative safe integer');
    if (op.outcome !== undefined && op.outcome !== 'EXPIRED' && op.outcome !== 'FAILED') {
      throw new TypeError('expire.outcome must be "EXPIRED" or "FAILED"');
    }
  }
}

function compareKeyed(a, b) {
  if (a.op.clock !== b.op.clock) return a.op.clock - b.op.clock;
  if (a.op.clientOpId !== b.op.clientOpId) return a.op.clientOpId < b.op.clientOpId ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function err(code) {
  return { status: STATUS.ERROR, error: code };
}

function missingParent(op, winners) {
  const parent = winners.get(op.parent);
  if (parent !== undefined && op.clock <= parent.clock) return err(ERRORS.TIME_TRAVEL);
  return err(ERRORS.BAD_PARENT);
}

function applyOp(state, op, winners) {
  switch (op.type) {
    case 'deposit': {
      state.available += op.amount;
      return { status: STATUS.APPLIED };
    }
    case 'authorize': {
      if (state.available < op.amount) return err(ERRORS.INSUFFICIENT);
      state.available -= op.amount;
      state.frozen += op.amount;
      const ttl = op.ttl === undefined ? DEFAULT_TTL : op.ttl;
      state.holds.set(op.clientOpId, {
        id: op.clientOpId,
        status: 'PENDING',
        amount: op.amount,
        remaining: op.amount,
        captured: 0,
        voided: 0,
        createdClock: op.clock,
        timeoutSlot: op.clock + ttl,
      });
      return { status: STATUS.APPLIED };
    }
    case 'confirm': {
      const hold = state.holds.get(op.parent);
      if (!hold) return missingParent(op, winners);
      if (op.clock <= hold.createdClock) return err(ERRORS.TIME_TRAVEL);
      if (hold.status === 'PENDING') {
        hold.status = 'CONFIRMED';
        return { status: STATUS.APPLIED };
      }
      if (hold.status === 'CONFIRMED') return { status: STATUS.IDEMPOTENT };
      return err(ERRORS.BAD_PARENT);
    }
    case 'capture': {
      const hold = state.holds.get(op.parent);
      if (!hold) return missingParent(op, winners);
      if (op.clock <= hold.createdClock) return err(ERRORS.TIME_TRAVEL);
      if (hold.status === 'PENDING' || hold.status === 'EXPIRED' || hold.status === 'FAILED') {
        return err(ERRORS.BAD_PARENT);
      }
      if (op.amount > hold.remaining) return err(ERRORS.FROZEN);
      hold.remaining -= op.amount;
      hold.captured += op.amount;
      state.frozen -= op.amount;
      state.captured += op.amount;
      if (hold.remaining === 0) hold.status = 'CLOSED';
      return { status: STATUS.APPLIED };
    }
    case 'void': {
      const hold = state.holds.get(op.parent);
      if (!hold) return missingParent(op, winners);
      if (op.clock <= hold.createdClock) return err(ERRORS.TIME_TRAVEL);
      if (hold.status === 'VOIDED') return { status: STATUS.IDEMPOTENT };
      if (hold.status === 'PENDING' || hold.status === 'EXPIRED' || hold.status === 'FAILED') {
        return err(ERRORS.BAD_PARENT);
      }
      if (hold.remaining === 0) return err(ERRORS.FROZEN);
      const amount = op.amount === undefined ? hold.remaining : op.amount;
      if (amount > hold.remaining) return err(ERRORS.FROZEN);
      hold.remaining -= amount;
      hold.voided += amount;
      state.frozen -= amount;
      state.available += amount;
      if (hold.remaining === 0) {
        hold.status = hold.voided === hold.amount ? 'VOIDED' : 'CLOSED';
      }
      return { status: STATUS.APPLIED };
    }
    case 'expire': {
      const hold = state.holds.get(op.parent);
      if (!hold) return missingParent(op, winners);
      if (op.clock <= hold.createdClock) return err(ERRORS.TIME_TRAVEL);
      if (hold.status === 'EXPIRED' || hold.status === 'FAILED') return { status: STATUS.IDEMPOTENT };
      if (hold.status === 'VOIDED' || hold.status === 'CLOSED') return err(ERRORS.FROZEN);
      if (op.slot < hold.timeoutSlot) return err(ERRORS.TIME_TRAVEL);
      state.frozen -= hold.remaining;
      state.available += hold.remaining;
      hold.remaining = 0;
      hold.status = op.outcome === 'FAILED' ? 'FAILED' : 'EXPIRED';
      return { status: STATUS.APPLIED };
    }
    default:
      throw new TypeError(`unknown op type: ${String(op.type)}`);
  }
}

function buildView(state) {
  const holds = [...state.holds.values()]
    .map((h) => Object.freeze({
      id: h.id,
      status: h.status,
      amount: h.amount,
      remaining: h.remaining,
      captured: h.captured,
      voided: h.voided,
      timeoutSlot: h.timeoutSlot,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze({
    available: state.available,
    frozen: state.frozen,
    captured: state.captured,
    holds: Object.freeze(holds),
  });
}

export function verifyLog(log) {
  if (!Array.isArray(log)) return false;
  let prev = sha256(GENESIS);
  for (const entry of log) {
    if (entry === null || typeof entry !== 'object') return false;
    const expect = sha256(prev + '\n' + canonical(entry.op) + '\n' + canonical(entry.result));
    if (expect !== entry.hash) return false;
    prev = entry.hash;
  }
  return true;
}

export class Ledger {
  #ops = new Map();
  #results = new Map();
  #log = [];
  #view = null;
  #head = '';

  constructor() {
    this.#recompute();
  }

  submit(op) {
    validateOp(op);
    const key = canonical(op);
    if (this.#ops.has(key)) {
      return { ...this.#results.get(key), dedup: true };
    }
    this.#ops.set(key, op);
    this.#recompute();
    return { ...this.#results.get(key) };
  }

  submitAll(ops) {
    if (!Array.isArray(ops)) throw new TypeError('submitAll expects an array of ops');
    const keys = [];
    for (const op of ops) {
      validateOp(op);
      keys.push(canonical(op));
    }
    for (let i = 0; i < ops.length; i++) {
      if (!this.#ops.has(keys[i])) this.#ops.set(keys[i], ops[i]);
    }
    this.#recompute();
    return keys.map((k) => ({ ...this.#results.get(k) }));
  }

  #recompute() {
    const entries = [...this.#ops.entries()].map(([key, op]) => ({ key, op })).sort(compareKeyed);
    const winners = new Map();
    for (const { op } of entries) {
      if (!winners.has(op.clientOpId)) winners.set(op.clientOpId, op);
    }
    const state = { available: 0, frozen: 0, captured: 0, holds: new Map() };
    const seen = new Map();
    const results = new Map();
    const log = [];
    let prev = sha256(GENESIS);
    for (const { key, op } of entries) {
      let result;
      if (seen.has(op.clientOpId)) {
        result = err(ERRORS.DUP_OP);
      } else {
        seen.set(op.clientOpId, key);
        result = applyOp(state, op, winners);
      }
      results.set(key, result);
      prev = sha256(prev + '\n' + key + '\n' + canonical(result));
      log.push(Object.freeze({ op: Object.freeze({ ...op }), result: Object.freeze({ ...result }), hash: prev }));
    }
    this.#results = results;
    this.#log = Object.freeze(log);
    this.#head = prev;
    this.#view = buildView(state);
  }

  get view() {
    return this.#view;
  }

  get log() {
    return this.#log;
  }

  get head() {
    return this.#head;
  }

  resultOf(op) {
    const result = this.#results.get(canonical(op));
    return result === undefined ? undefined : { ...result };
  }
}
