import { createHash } from 'node:crypto';

export class LedgerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashEvent(content) {
  const { hash, ...rest } = content;
  return sha256(canonicalize(rest));
}

export class Ledger {
  constructor(replica = 'replica-1', events = []) {
    this.replica = replica;
    this.events = new Map();
    for (const event of events) this.events.set(event.hash, event);
  }

  static fromJSON(json) {
    return new Ledger(json.replica ?? 'replica-1', json.events ?? []);
  }

  toJSON() {
    return { replica: this.replica, events: [...this.events.values()] };
  }

  voucherEvents(voucherId) {
    return [...this.events.values()].filter((e) => e.voucherId === voucherId);
  }

  heads(voucherId) {
    const events = this.voucherEvents(voucherId);
    const referenced = new Set(events.map((e) => e.predecessor).filter(Boolean));
    return events
      .filter((e) => !referenced.has(e.hash))
      .map((e) => e.hash)
      .sort();
  }

  ancestors(hash) {
    const seen = new Set();
    const stack = [hash];
    while (stack.length > 0) {
      const current = this.events.get(stack.pop());
      if (!current || !current.predecessor || seen.has(current.predecessor)) continue;
      seen.add(current.predecessor);
      stack.push(current.predecessor);
    }
    return seen;
  }

  commit(content) {
    const event = { ...content, hash: hashEvent(content) };
    this.events.set(event.hash, event);
    return event;
  }

  put(voucherId, amount, status) {
    if (this.voucherEvents(voucherId).length > 0) throw new LedgerError('voucher-exists');
    const clock = { [this.replica]: 1 };
    return this.commit({ voucherId, version: 1, amount, status, predecessor: null, clock });
  }

  correct(voucherId, amount, status, predecessor) {
    const known = this.voucherEvents(voucherId);
    const heads = this.heads(voucherId);
    let target = predecessor;
    if (target === undefined || target === null) {
      if (known.length === 0) throw new LedgerError('unknown-predecessor');
      if (heads.length !== 1) throw new LedgerError('unresolved-conflict');
      target = heads[0];
    }
    const pred = this.events.get(target);
    if (!pred || pred.voucherId !== voucherId) throw new LedgerError('unknown-predecessor');
    if (!heads.includes(target)) throw new LedgerError('stale-clock');
    const clock = { ...pred.clock };
    clock[this.replica] = (clock[this.replica] ?? 0) + 1;
    return this.commit({
      voucherId,
      version: pred.version + 1,
      amount,
      status,
      predecessor: target,
      clock,
    });
  }

  merge(other) {
    for (const event of other.events.values()) this.events.set(event.hash, event);
  }

  missing() {
    const out = [];
    for (const event of this.events.values()) {
      if (event.predecessor && !this.events.has(event.predecessor)) out.push(event.hash);
    }
    return out.sort();
  }

  conflicts() {
    const result = new Map();
    const voucherIds = new Set([...this.events.values()].map((e) => e.voucherId));
    for (const voucherId of voucherIds) {
      const heads = this.heads(voucherId);
      if (heads.length < 2) continue;
      const headEvents = heads.map((h) => this.events.get(h));
      let divergent = false;
      for (let i = 0; i < headEvents.length && !divergent; i++) {
        for (let j = i + 1; j < headEvents.length; j++) {
          if (
            headEvents[i].amount !== headEvents[j].amount ||
            headEvents[i].status !== headEvents[j].status
          ) {
            divergent = true;
            break;
          }
        }
      }
      if (divergent) result.set(voucherId, heads);
    }
    return result;
  }

  get(voucherId) {
    const heads = this.heads(voucherId);
    if (heads.length === 0) throw new LedgerError('unknown-voucher');
    const best = heads
      .map((h) => this.events.get(h))
      .sort((a, b) => a.version - b.version || (a.hash < b.hash ? -1 : 1))
      .pop();
    return {
      voucherId,
      version: best.version,
      amount: best.amount,
      status: best.status,
      hash: best.hash,
      conflict: this.conflicts().has(voucherId),
      heads,
    };
  }

  certificate() {
    const voucherIds = [...new Set([...this.events.values()].map((e) => e.voucherId))].sort();
    const frontier = {};
    const voucherHashes = {};
    for (const voucherId of voucherIds) {
      const heads = this.heads(voucherId);
      frontier[voucherId] = heads;
      voucherHashes[voucherId] = sha256(heads.join(':'));
    }
    const conflictCount = this.conflicts().size;
    const missingCount = this.missing().length;
    return {
      status: conflictCount > 0 || missingCount > 0 ? 'invalid' : 'valid',
      frontier,
      voucherHashes,
      conflicts: conflictCount,
      missing: missingCount,
    };
  }
}
