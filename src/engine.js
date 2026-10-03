import { createHash } from 'node:crypto';

export const DEFAULT_TTL = 10;

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const FIELDS = {
  deposit: ['type', 'clientOpId', 'clock', 'amount'],
  authorize: ['type', 'clientOpId', 'clock', 'amount', 'ttl'],
  capture: ['type', 'clientOpId', 'clock', 'parentId', 'amount'],
  reverse: ['type', 'clientOpId', 'clock', 'parentId', 'amount'],
  expire: ['type', 'clientOpId', 'clock', 'parentId'],
};

export function normalizeOp(op) {
  const fields = FIELDS[op.type];
  if (!fields) return null;
  const out = {};
  for (const field of fields) {
    if (op[field] !== undefined) out[field] = op[field];
  }
  return out;
}

export function validateOp(op) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return 'op must be an object';
  if (!FIELDS[op.type]) return `unknown op type: ${String(op.type)}`;
  if (typeof op.clientOpId !== 'string' || op.clientOpId.length === 0) {
    return 'clientOpId must be a non-empty string';
  }
  if (typeof op.clock !== 'number' || !Number.isFinite(op.clock) || op.clock < 0) {
    return 'clock must be a non-negative finite number';
  }
  const amountRequired = op.type === 'deposit' || op.type === 'authorize' || op.type === 'capture';
  if (amountRequired || op.amount !== undefined) {
    if (typeof op.amount !== 'number' || !Number.isInteger(op.amount) || op.amount <= 0) {
      return 'amount must be a positive integer';
    }
  }
  if ((op.type === 'capture' || op.type === 'reverse' || op.type === 'expire')
      && (typeof op.parentId !== 'string' || op.parentId.length === 0)) {
    return 'parentId must be a non-empty string';
  }
  if (op.ttl !== undefined && (typeof op.ttl !== 'number' || !Number.isFinite(op.ttl) || op.ttl <= 0)) {
    return 'ttl must be a positive number';
  }
  return null;
}

function compareOps(a, b) {
  if (a.clock !== b.clock) return a.clock - b.clock;
  return a.clientOpId < b.clientOpId ? -1 : a.clientOpId > b.clientOpId ? 1 : 0;
}

function freshState(initialBalance) {
  return {
    available: initialBalance,
    frozen: 0,
    auths: new Map(),
    captures: new Map(),
    reversals: new Map(),
    totals: { captured: 0, refunded: 0, voided: 0, expired: 0 },
  };
}

function releaseRemaining(state, auth, nextState) {
  state.frozen -= auth.remaining;
  state.available += auth.remaining;
  if (nextState === 'EXPIRED') state.totals.expired += auth.remaining;
  auth.remaining = 0;
  auth.state = nextState;
}

function err(code) {
  return { status: 'ERROR', code };
}

function applyOp(state, op, known) {
  switch (op.type) {
    case 'deposit': {
      state.available += op.amount;
      return { status: 'OK', deposited: op.amount };
    }
    case 'authorize': {
      if (op.amount > state.available) return err('INSUFFICIENT');
      state.available -= op.amount;
      state.frozen += op.amount;
      const ttl = op.ttl ?? DEFAULT_TTL;
      state.auths.set(op.clientOpId, {
        id: op.clientOpId,
        amount: op.amount,
        remaining: op.amount,
        captured: 0,
        reversed: 0,
        state: 'PENDING',
        clock: op.clock,
        expiresAt: op.clock + ttl,
      });
      return { status: 'OK', authId: op.clientOpId, expiresAt: op.clock + ttl };
    }
    case 'capture': {
      const auth = state.auths.get(op.parentId);
      if (!auth) {
        const parent = known.get(op.parentId);
        return parent && parent.clock > op.clock ? err('TIME_TRAVEL') : err('BAD_PARENT');
      }
      if (auth.state === 'EXPIRED' || auth.state === 'FAILED') return err('FROZEN');
      if (auth.state === 'PENDING' && op.clock >= auth.expiresAt) {
        releaseRemaining(state, auth, 'FAILED');
        return err('FROZEN');
      }
      if (op.amount > auth.remaining) return err('INSUFFICIENT');
      auth.remaining -= op.amount;
      auth.captured += op.amount;
      state.frozen -= op.amount;
      state.totals.captured += op.amount;
      if (auth.remaining === 0) auth.state = 'CAPTURED';
      state.captures.set(op.clientOpId, {
        id: op.clientOpId, authId: auth.id, amount: op.amount, reversed: 0, clock: op.clock,
      });
      return { status: 'OK', captured: op.amount, authId: auth.id };
    }
    case 'reverse': {
      let root = state.auths.get(op.parentId);
      let rootType = 'authorize';
      if (!root) {
        root = state.captures.get(op.parentId);
        rootType = 'capture';
      }
      if (!root) {
        const prev = state.reversals.get(op.parentId);
        if (!prev) {
          const parent = known.get(op.parentId);
          return parent && parent.clock > op.clock ? err('TIME_TRAVEL') : err('BAD_PARENT');
        }
        rootType = prev.rootType;
        root = prev.rootType === 'authorize'
          ? state.auths.get(prev.rootId)
          : state.captures.get(prev.rootId);
      }
      if (rootType === 'authorize') {
        if (root.state === 'EXPIRED' || root.state === 'FAILED') return err('FROZEN');
        if (root.state === 'REVERSED') {
          return { status: 'IDEMPOTENT', rootId: root.id, cumulative: root.reversed };
        }
        if (root.state === 'PENDING' && op.clock >= root.expiresAt) {
          releaseRemaining(state, root, 'FAILED');
          return err('FROZEN');
        }
        if (root.remaining === 0) {
          return { status: 'IDEMPOTENT', rootId: root.id, cumulative: root.reversed };
        }
        const amount = op.amount ?? root.remaining;
        if (amount > root.remaining) return err('INSUFFICIENT');
        root.remaining -= amount;
        root.reversed += amount;
        state.frozen -= amount;
        state.available += amount;
        state.totals.voided += amount;
        if (root.remaining === 0) root.state = root.captured > 0 ? 'CAPTURED' : 'REVERSED';
        state.reversals.set(op.clientOpId, {
          id: op.clientOpId, rootId: root.id, rootType, amount, clock: op.clock,
        });
        return { status: 'OK', reversed: amount, rootId: root.id, cumulative: root.reversed };
      }
      const left = root.amount - root.reversed;
      if (left === 0) {
        return { status: 'IDEMPOTENT', rootId: root.id, cumulative: root.reversed };
      }
      const amount = op.amount ?? left;
      if (amount > left) return err('INSUFFICIENT');
      root.reversed += amount;
      state.available += amount;
      state.totals.refunded += amount;
      state.reversals.set(op.clientOpId, {
        id: op.clientOpId, rootId: root.id, rootType, amount, clock: op.clock,
      });
      return { status: 'OK', reversed: amount, rootId: root.id, cumulative: root.reversed };
    }
    case 'expire': {
      const auth = state.auths.get(op.parentId);
      if (!auth) {
        const parent = known.get(op.parentId);
        return parent && parent.clock > op.clock ? err('TIME_TRAVEL') : err('BAD_PARENT');
      }
      if (auth.state !== 'PENDING') return { status: 'IDEMPOTENT', transition: auth.state };
      if (op.clock < auth.expiresAt) return { status: 'PENDING', expiresAt: auth.expiresAt };
      releaseRemaining(state, auth, 'EXPIRED');
      return { status: 'OK', transition: 'EXPIRED' };
    }
    default:
      return err('BAD_OP');
  }
}

function stateDigest(state) {
  const auths = [...state.auths.values()].map((a) => [
    a.id, a.amount, a.remaining, a.captured, a.reversed, a.state, a.clock, a.expiresAt,
  ]);
  const captures = [...state.captures.values()].map((c) => [
    c.id, c.authId, c.amount, c.reversed, c.clock,
  ]);
  const reversals = [...state.reversals.values()].map((r) => [
    r.id, r.rootId, r.rootType, r.amount, r.clock,
  ]);
  return sha256(stableStringify({
    available: state.available,
    frozen: state.frozen,
    totals: state.totals,
    auths,
    captures,
    reversals,
  }));
}

export function genesisHash(initialBalance) {
  return sha256(`genesis:${initialBalance}`);
}

export function verifyHashChain(log, initialBalance = 0) {
  let prev = genesisHash(initialBalance);
  for (const entry of log) {
    if (entry.prevHash !== prev) return false;
    const expected = sha256(
      [prev, stableStringify(entry.op), stableStringify(entry.result), entry.stateDigest].join('|'),
    );
    if (entry.hash !== expected) return false;
    prev = entry.hash;
  }
  return true;
}

export class Engine {
  constructor({ initialBalance = 0, hashChain = true } = {}) {
    if (!Number.isInteger(initialBalance) || initialBalance < 0) {
      throw new RangeError('initialBalance must be a non-negative integer');
    }
    this.initialBalance = initialBalance;
    this.hashChain = hashChain;
    this.submissions = new Map();
    this.#recompute();
  }

  submit(rawOp) {
    const invalid = validateOp(rawOp);
    if (invalid) return { status: 'ERROR', code: 'BAD_OP', message: invalid };
    const op = normalizeOp(rawOp);
    const key = stableStringify(op);
    const prior = this.submissions.get(op.clientOpId);
    if (prior) {
      if (prior.key !== key) return { status: 'ERROR', code: 'DUP_OP', clientOpId: op.clientOpId };
      return { ...this.results.get(op.clientOpId), replay: true };
    }
    this.submissions.set(op.clientOpId, { key, op });
    this.#recompute();
    return this.results.get(op.clientOpId);
  }

  load(ops) {
    for (const rawOp of ops) {
      const invalid = validateOp(rawOp);
      if (invalid) throw new TypeError(`invalid op ${JSON.stringify(rawOp)}: ${invalid}`);
      const op = normalizeOp(rawOp);
      const key = stableStringify(op);
      const prior = this.submissions.get(op.clientOpId);
      if (prior) {
        if (prior.key !== key) throw new Error(`DUP_OP: ${op.clientOpId}`);
        continue;
      }
      this.submissions.set(op.clientOpId, { key, op });
    }
    this.#recompute();
    return this.results;
  }

  #recompute() {
    const ops = [...this.submissions.values()].map((s) => s.op).sort(compareOps);
    const known = new Map(ops.map((op) => [op.clientOpId, op]));
    const state = freshState(this.initialBalance);
    const log = [];
    const results = new Map();
    let prevHash = genesisHash(this.initialBalance);
    ops.forEach((op, seq) => {
      const result = applyOp(state, op, known);
      results.set(op.clientOpId, result);
      if (this.hashChain) {
        const digest = stateDigest(state);
        const hash = sha256(
          [prevHash, stableStringify(op), stableStringify(result), digest].join('|'),
        );
        log.push({ seq, op, result, stateDigest: digest, prevHash, hash });
        prevHash = hash;
      } else {
        log.push({ seq, op, result });
      }
    });
    this.state = state;
    this.log = log;
    this.results = results;
    this.tipHash = prevHash;
  }

  view() {
    const s = this.state;
    let openAuthorizations = 0;
    let terminalAuthorizations = 0;
    for (const auth of s.auths.values()) {
      if (auth.state === 'PENDING') openAuthorizations += 1;
      else terminalAuthorizations += 1;
    }
    return {
      available: s.available,
      frozen: s.frozen,
      captured: s.totals.captured - s.totals.refunded,
      refunded: s.totals.refunded,
      voided: s.totals.voided,
      expired: s.totals.expired,
      openAuthorizations,
      terminalAuthorizations,
    };
  }
}
