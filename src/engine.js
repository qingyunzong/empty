export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

class Reject extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const EVENT_TYPES = new Set(['open_account', 'authorize', 'release', 'void', 'capture']);

export function compareEvents(a, b) {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.requestId === b.requestId) return 0;
  return a.requestId < b.requestId ? -1 : 1;
}

export function sortEvents(events) {
  return [...events].sort(compareEvents);
}

function isAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object') {
    throw new EngineError('BAD_EVENT', 'event must be an object');
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new EngineError('BAD_EVENT', `unknown event type: ${String(event.type)}`);
  }
  if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) {
    throw new EngineError('BAD_EVENT', 'event.seq must be a finite number');
  }
  if (typeof event.requestId !== 'string' || event.requestId.length === 0) {
    throw new EngineError('BAD_EVENT', 'event.requestId must be a non-empty string');
  }
  switch (event.type) {
    case 'open_account':
      if (typeof event.account !== 'string' || event.account.length === 0) {
        throw new EngineError('BAD_EVENT', 'open_account.account must be a non-empty string');
      }
      if (typeof event.limit !== 'number' || !Number.isFinite(event.limit) || event.limit < 0) {
        throw new EngineError('BAD_EVENT', 'open_account.limit must be a number >= 0');
      }
      break;
    case 'authorize':
      if (typeof event.authId !== 'string' || event.authId.length === 0) {
        throw new EngineError('BAD_EVENT', 'authorize.authId must be a non-empty string');
      }
      if (typeof event.account !== 'string' || event.account.length === 0) {
        throw new EngineError('BAD_EVENT', 'authorize.account must be a non-empty string');
      }
      if (!isAmount(event.amount)) {
        throw new EngineError('BAD_EVENT', 'authorize.amount must be a number > 0');
      }
      break;
    case 'release':
    case 'capture':
      if (typeof event.authId !== 'string' || event.authId.length === 0) {
        throw new EngineError('BAD_EVENT', `${event.type}.authId must be a non-empty string`);
      }
      if (!isAmount(event.amount)) {
        throw new EngineError('BAD_EVENT', `${event.type}.amount must be a number > 0`);
      }
      if (event.type === 'capture' && event.merchant !== undefined && typeof event.merchant !== 'string') {
        throw new EngineError('BAD_EVENT', 'capture.merchant must be a string when present');
      }
      break;
    case 'void':
      if (typeof event.authId !== 'string' || event.authId.length === 0) {
        throw new EngineError('BAD_EVENT', 'void.authId must be a non-empty string');
      }
      break;
  }
}

export class Engine {
  constructor() {
    this.accounts = new Map();
    this.auths = new Map();
    this.merchants = new Map();
    this.journal = [];
  }

  apply(event) {
    validateEvent(event);
    const record = {
      seq: event.seq,
      requestId: event.requestId,
      type: event.type,
      ok: true,
      deltas: [],
      event,
    };
    try {
      switch (event.type) {
        case 'open_account':
          this.#openAccount(event, record);
          break;
        case 'authorize':
          this.#authorize(event, record);
          break;
        case 'release':
          this.#release(event, record);
          break;
        case 'void':
          this.#void(event, record);
          break;
        case 'capture':
          this.#capture(event, record);
          break;
      }
    } catch (err) {
      if (err instanceof Reject) {
        record.ok = false;
        record.reason = err.code;
        record.deltas = [];
      } else {
        throw err;
      }
    }
    this.journal.push(record);
    return record;
  }

  applyAll(events) {
    const records = [];
    for (const event of sortEvents(events)) {
      records.push(this.apply(event));
    }
    return records;
  }

  #openAccount(event, record) {
    if (this.accounts.has(event.account)) throw new Reject('ACCOUNT_EXISTS');
    this.accounts.set(event.account, { limit: event.limit, held: 0, captured: 0 });
    record.deltas.push({ node: `account:${event.account}`, field: 'limit', before: null, after: event.limit });
  }

  #authorize(event, record) {
    const account = this.accounts.get(event.account);
    if (!account) throw new Reject('NO_ACCOUNT');
    const existing = this.auths.get(event.authId);
    let generation = 1;
    if (existing) {
      if (existing.status === 'active') throw new Reject('DUPLICATE_AUTH');
      generation = existing.generation + 1;
      record.deltas.push({
        node: `auth:${event.authId}#${existing.generation}`,
        field: 'status',
        before: existing.status,
        after: 'invalidated',
      });
    }
    const available = account.limit - account.held - account.captured;
    if (event.amount > available) throw new Reject('INSUFFICIENT');
    account.held += event.amount;
    this.auths.set(event.authId, {
      account: event.account,
      amount: event.amount,
      heldRemaining: event.amount,
      captured: 0,
      status: 'active',
      generation,
    });
    record.deltas.push({ node: `account:${event.account}`, field: 'held', before: account.held - event.amount, after: account.held });
    record.deltas.push({ node: `auth:${event.authId}#${generation}`, field: 'heldRemaining', before: null, after: event.amount });
  }

  #release(event, record) {
    const auth = this.auths.get(event.authId);
    if (!auth || auth.status !== 'active') throw new Reject('NO_ACTIVE_AUTH');
    if (event.amount > auth.heldRemaining) throw new Reject('EXCEEDS_HOLD');
    const account = this.accounts.get(auth.account);
    const heldBefore = account.held;
    account.held -= event.amount;
    auth.heldRemaining -= event.amount;
    record.deltas.push({ node: `auth:${event.authId}#${auth.generation}`, field: 'heldRemaining', before: auth.heldRemaining + event.amount, after: auth.heldRemaining });
    record.deltas.push({ node: `account:${auth.account}`, field: 'held', before: heldBefore, after: account.held });
  }

  #void(event, record) {
    const auth = this.auths.get(event.authId);
    if (!auth || auth.status !== 'active') throw new Reject('NO_ACTIVE_AUTH');
    const account = this.accounts.get(auth.account);
    const heldBefore = account.held;
    const remaining = auth.heldRemaining;
    account.held -= remaining;
    auth.heldRemaining = 0;
    auth.status = 'voided';
    record.deltas.push({ node: `auth:${event.authId}#${auth.generation}`, field: 'status', before: 'active', after: 'voided' });
    record.deltas.push({ node: `account:${auth.account}`, field: 'held', before: heldBefore, after: account.held });
    if (remaining > 0) {
      record.deltas.push({ node: `account:${auth.account}`, field: 'available', before: account.limit - heldBefore - account.captured, after: account.limit - account.held - account.captured });
    }
  }

  #capture(event, record) {
    const auth = this.auths.get(event.authId);
    if (!auth || auth.status !== 'active') throw new Reject('NO_ACTIVE_AUTH');
    if (event.amount > auth.heldRemaining) throw new Reject('EXCEEDS_HOLD');
    const account = this.accounts.get(auth.account);
    const merchant = event.merchant ?? 'default';
    const heldBefore = account.held;
    const capturedBefore = account.captured;
    const merchantBefore = this.merchants.get(merchant) ?? 0;
    account.held -= event.amount;
    account.captured += event.amount;
    auth.heldRemaining -= event.amount;
    auth.captured += event.amount;
    this.merchants.set(merchant, merchantBefore + event.amount);
    record.deltas.push({ node: `auth:${event.authId}#${auth.generation}`, field: 'heldRemaining', before: auth.heldRemaining + event.amount, after: auth.heldRemaining });
    record.deltas.push({ node: `account:${auth.account}`, field: 'held', before: heldBefore, after: account.held });
    record.deltas.push({ node: `account:${auth.account}`, field: 'captured', before: capturedBefore, after: account.captured });
    record.deltas.push({ node: `merchant:${merchant}`, field: 'settled', before: merchantBefore, after: merchantBefore + event.amount });
  }

  snapshot() {
    const accounts = {};
    for (const [id, acc] of [...this.accounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      accounts[id] = {
        limit: acc.limit,
        held: acc.held,
        captured: acc.captured,
        available: acc.limit - acc.held - acc.captured,
      };
    }
    const auths = {};
    for (const [id, auth] of [...this.auths.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      auths[id] = {
        account: auth.account,
        amount: auth.amount,
        heldRemaining: auth.heldRemaining,
        captured: auth.captured,
        status: auth.status,
        generation: auth.generation,
      };
    }
    const merchants = {};
    for (const [id, total] of [...this.merchants.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      merchants[id] = { settled: total };
    }
    return { accounts, auths, merchants };
  }
}

export function replay(events, prefix = Number.POSITIVE_INFINITY) {
  const engine = new Engine();
  const ordered = sortEvents(events);
  const count = Math.min(prefix, ordered.length);
  for (let i = 0; i < count; i += 1) {
    engine.apply(ordered[i]);
  }
  return engine;
}
