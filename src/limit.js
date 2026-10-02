export const E_LIMIT = 'E_LIMIT';
export const E_STATE = 'E_STATE';
export const E_EXPIRED = 'E_EXPIRED';

export class LimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LimitError';
    this.code = code;
  }
}

const ACTIVE = 'active';
const CAPTURED = 'captured';
const RELEASED = 'released';
const EXPIRED = 'expired';

function checkAmount(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new LimitError(E_STATE, `${name} must be a positive finite number, got ${value}`);
  }
}

function checkTtl(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LimitError(E_STATE, `ttl must be a non-negative finite number, got ${value}`);
  }
}

export class Ledger {
  constructor() {
    this.accounts = new Map();
    this.auths = new Map();
  }

  clone() {
    const copy = new Ledger();
    for (const [name, acct] of this.accounts) {
      copy.accounts.set(name, { ...acct });
    }
    for (const [id, auth] of this.auths) {
      copy.auths.set(id, { ...auth });
    }
    return copy;
  }

  open(acc, creditLimit) {
    if (this.accounts.has(acc)) {
      throw new LimitError(E_STATE, `account already exists: ${acc}`);
    }
    if (typeof creditLimit !== 'number' || !Number.isFinite(creditLimit) || creditLimit < 0) {
      throw new LimitError(E_STATE, `creditLimit must be a non-negative finite number`);
    }
    this.accounts.set(acc, { creditLimit, frozen: 0, used: 0 });
  }

  account(acc) {
    const acct = this.accounts.get(acc);
    if (!acct) throw new LimitError(E_STATE, `unknown account: ${acc}`);
    return acct;
  }

  available(acc) {
    const acct = this.account(acc);
    return acct.creditLimit - acct.frozen - acct.used;
  }

  _expire(now) {
    for (const auth of this.auths.values()) {
      if (auth.state === ACTIVE && auth.expiresAt <= now) {
        const acct = this.accounts.get(auth.acc);
        acct.frozen -= auth.amount - auth.captured;
        auth.state = EXPIRED;
      }
    }
  }

  scan(now) {
    this._expire(now);
  }

  _activeAuth(authId) {
    const auth = this.auths.get(authId);
    if (!auth) throw new LimitError(E_STATE, `unknown authId: ${authId}`);
    if (auth.state === EXPIRED) {
      throw new LimitError(E_EXPIRED, `authorization expired: ${authId}`);
    }
    if (auth.state !== ACTIVE) {
      throw new LimitError(E_STATE, `authorization not active (${auth.state}): ${authId}`);
    }
    return auth;
  }

  freeze(authId, acc, amount, ttl, now) {
    this._expire(now);
    if (this.auths.has(authId)) {
      throw new LimitError(E_STATE, `authId already exists: ${authId}`);
    }
    const acct = this.account(acc);
    checkAmount(amount, 'amount');
    checkTtl(ttl);
    if (amount > acct.creditLimit - acct.frozen - acct.used) {
      throw new LimitError(E_LIMIT, `freeze ${amount} exceeds available credit`);
    }
    acct.frozen += amount;
    this.auths.set(authId, {
      authId,
      acc,
      amount,
      captured: 0,
      expiresAt: now + ttl,
      state: ACTIVE,
    });
  }

  capture(authId, amount, now) {
    this._expire(now);
    const auth = this._activeAuth(authId);
    checkAmount(amount, 'amount');
    const remaining = auth.amount - auth.captured;
    if (amount > remaining) {
      throw new LimitError(E_LIMIT, `capture ${amount} exceeds remaining frozen ${remaining}`);
    }
    const acct = this.accounts.get(auth.acc);
    auth.captured += amount;
    acct.frozen -= amount;
    acct.used += amount;
    if (auth.captured === auth.amount) auth.state = CAPTURED;
  }

  release(authId, now) {
    this._expire(now);
    const auth = this._activeAuth(authId);
    const acct = this.accounts.get(auth.acc);
    acct.frozen -= auth.amount - auth.captured;
    auth.state = RELEASED;
  }

  extend(authId, ttl, now) {
    this._expire(now);
    const auth = this._activeAuth(authId);
    checkTtl(ttl);
    auth.expiresAt = now + ttl;
  }

  snapshot() {
    const accounts = {};
    for (const [name, acct] of this.accounts) accounts[name] = { ...acct };
    const auths = {};
    for (const [id, auth] of this.auths) auths[id] = { ...auth };
    return { accounts, auths };
  }
}

export function applyOp(ledger, op) {
  try {
    switch (op.op) {
      case 'open':
        ledger.open(op.acc, op.creditLimit);
        break;
      case 'freeze':
        ledger.freeze(op.authId, op.acc, op.amount, op.ttl, op.t ?? 0);
        break;
      case 'capture':
        ledger.capture(op.authId, op.amount, op.t ?? 0);
        break;
      case 'release':
        ledger.release(op.authId, op.t ?? 0);
        break;
      case 'extend':
        ledger.extend(op.authId, op.ttl, op.t ?? 0);
        break;
      case 'scan':
        ledger.scan(op.t ?? 0);
        break;
      default:
        return E_STATE;
    }
    return 'ok';
  } catch (err) {
    if (err instanceof LimitError) return err.code;
    throw err;
  }
}
