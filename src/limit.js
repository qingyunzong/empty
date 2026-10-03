// Pre-authorization credit limit ledger.
//
// Account state: { creditLimit, frozen, used }.
//   - frozen: sum of remaining amounts of open authorizations.
//   - used:   sum of captured amounts (terminal).
//   - available = creditLimit - frozen - used.
//
// Operations: open, freeze, capture, release, extend, sweep.
// Errors carry a .code of E_LIMIT, E_STATE or E_EXPIRED.
//
// Expiry semantics: an authorization with expiresAt is expired at any
// event time t with t >= expiresAt (boundary 'exactly ttl' is expired).
// Expiry is lazy (checked on every op touching the account, at the op's
// event time) and can also be driven by an explicit periodic sweep(t);
// both produce identical observable state. An expired authorization that
// was not fully captured releases its remaining frozen amount.

export const MAX_OPS = 20000;

export class LimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LimitError';
    this.code = code;
  }
}

function isPosNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export class Ledger {
  // defaultLimit: when non-null, unknown accounts are auto-opened with
  // this credit limit on first use (used by the CLI --limit flag).
  constructor(defaultLimit = null) {
    this.defaultLimit = defaultLimit;
    this.accounts = new Map(); // name -> { creditLimit, frozen, used, auths: Map }
    this.authIndex = new Map(); // authId -> account name (authIds are globally unique)
  }

  clone() {
    const copy = new Ledger(this.defaultLimit);
    for (const [name, acc] of this.accounts) {
      const auths = new Map();
      for (const [id, auth] of acc.auths) auths.set(id, { ...auth });
      copy.accounts.set(name, {
        creditLimit: acc.creditLimit,
        frozen: acc.frozen,
        used: acc.used,
        auths,
      });
    }
    copy.authIndex = new Map(this.authIndex);
    return copy;
  }

  open(acc, creditLimit) {
    if (typeof acc !== 'string' || acc.length === 0) {
      throw new LimitError('E_STATE', 'open: acc must be a non-empty string');
    }
    if (this.accounts.has(acc)) {
      throw new LimitError('E_STATE', 'open: account already exists: ' + acc);
    }
    if (typeof creditLimit !== 'number' || !Number.isFinite(creditLimit) || creditLimit < 0) {
      throw new LimitError('E_STATE', 'open: creditLimit must be a number >= 0');
    }
    this.accounts.set(acc, { creditLimit, frozen: 0, used: 0, auths: new Map() });
  }

  freeze({ authId, acc, amount, ttl, time = 0 }) {
    const account = this._ensureAccount(acc);
    this._expireAccount(account, time);
    if (typeof authId !== 'string' || authId.length === 0) {
      throw new LimitError('E_STATE', 'freeze: authId must be a non-empty string');
    }
    if (this.authIndex.has(authId)) {
      throw new LimitError('E_STATE', 'freeze: authId already used: ' + authId);
    }
    if (!isPosNumber(amount)) {
      throw new LimitError('E_STATE', 'freeze: amount must be a number > 0');
    }
    if (!isPosNumber(ttl)) {
      throw new LimitError('E_STATE', 'freeze: ttl must be a number > 0');
    }
    const available = account.creditLimit - account.frozen - account.used;
    if (amount > available) {
      throw new LimitError(
        'E_LIMIT',
        'freeze: amount ' + amount + ' exceeds available ' + available + ' on account ' + acc,
      );
    }
    const auth = {
      id: authId,
      acc,
      amount,
      remaining: amount,
      expiresAt: time + ttl,
      status: 'open',
    };
    account.auths.set(authId, auth);
    this.authIndex.set(authId, acc);
    account.frozen += amount;
    return { expiresAt: auth.expiresAt };
  }

  capture({ authId, amount, time = 0 }) {
    const { account, auth } = this._locate(authId, 'capture');
    this._expireAccount(account, time);
    if (auth.status === 'expired') {
      throw new LimitError('E_EXPIRED', 'capture: auth expired: ' + authId);
    }
    if (auth.status !== 'open') {
      throw new LimitError('E_STATE', 'capture: auth not open (' + auth.status + '): ' + authId);
    }
    if (!isPosNumber(amount)) {
      throw new LimitError('E_STATE', 'capture: amount must be a number > 0');
    }
    if (amount > auth.remaining) {
      throw new LimitError(
        'E_LIMIT',
        'capture: amount ' + amount + ' exceeds frozen remainder ' + auth.remaining + ' on auth ' + authId,
      );
    }
    auth.remaining -= amount;
    account.frozen -= amount;
    account.used += amount;
    if (auth.remaining === 0) auth.status = 'captured';
    return { remaining: auth.remaining };
  }

  release({ authId, time = 0 }) {
    const { account, auth } = this._locate(authId, 'release');
    this._expireAccount(account, time);
    if (auth.status === 'expired') {
      throw new LimitError('E_EXPIRED', 'release: auth expired: ' + authId);
    }
    if (auth.status !== 'open') {
      throw new LimitError('E_STATE', 'release: auth not open (' + auth.status + '): ' + authId);
    }
    account.frozen -= auth.remaining;
    auth.remaining = 0;
    auth.status = 'released';
    return {};
  }

  extend({ authId, ttl, time = 0 }) {
    const { account, auth } = this._locate(authId, 'extend');
    this._expireAccount(account, time);
    if (auth.status === 'expired') {
      throw new LimitError('E_EXPIRED', 'extend: auth expired: ' + authId);
    }
    if (auth.status !== 'open') {
      throw new LimitError('E_STATE', 'extend: auth not open (' + auth.status + '): ' + authId);
    }
    if (!isPosNumber(ttl)) {
      throw new LimitError('E_STATE', 'extend: ttl must be a number > 0');
    }
    auth.expiresAt += ttl;
    return { expiresAt: auth.expiresAt };
  }

  // Periodic scan: expire every open authorization with expiresAt <= time.
  // Observable state afterwards is identical to what lazy expiry would
  // produce for any op at event time .
  sweep(time) {
    for (const account of this.accounts.values()) this._expireAccount(account, time);
  }

  apply(op) {
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string') {
      throw new LimitError('E_STATE', 'malformed op: missing op field');
    }
    switch (op.op) {
      case 'open':
        this.open(op.acc, op.creditLimit);
        return {};
      case 'freeze':
        return this.freeze(op);
      case 'capture':
        return this.capture(op);
      case 'release':
        return this.release(op);
      case 'extend':
        return this.extend(op);
      case 'sweep':
        this.sweep(op.time ?? 0);
        return {};
      default:
        throw new LimitError('E_STATE', 'unknown op: ' + op.op);
    }
  }

  // Plain-object snapshot of all account state (for --explain and tests).
  state() {
    const accounts = {};
    for (const [name, acc] of this.accounts) {
      const auths = {};
      for (const [id, auth] of acc.auths) {
        auths[id] = {
          amount: auth.amount,
          remaining: auth.remaining,
          expiresAt: auth.expiresAt,
          status: auth.status,
        };
      }
      accounts[name] = {
        creditLimit: acc.creditLimit,
        frozen: acc.frozen,
        used: acc.used,
        available: acc.creditLimit - acc.frozen - acc.used,
        auths,
      };
    }
    return { accounts };
  }

  _ensureAccount(acc) {
    if (typeof acc !== 'string' || acc.length === 0) {
      throw new LimitError('E_STATE', 'acc must be a non-empty string');
    }
    let account = this.accounts.get(acc);
    if (!account) {
      if (this.defaultLimit === null) {
        throw new LimitError('E_STATE', 'unknown account: ' + acc);
      }
      this.open(acc, this.defaultLimit);
      account = this.accounts.get(acc);
    }
    return account;
  }

  _locate(authId, opName) {
    const accName = this.authIndex.get(authId);
    if (accName === undefined) {
      throw new LimitError('E_STATE', opName + ': unknown auth: ' + String(authId));
    }
    const account = this.accounts.get(accName);
    return { account, auth: account.auths.get(authId) };
  }

  _expireAccount(account, time) {
    for (const auth of account.auths.values()) {
      if (auth.status === 'open' && time >= auth.expiresAt) {
        auth.status = 'expired';
        account.frozen -= auth.remaining;
        auth.remaining = 0;
      }
    }
  }
}
