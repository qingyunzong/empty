'use strict';

const crypto = require('node:crypto');

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SEQ_CONFLICT';
    this.exitCode = 3;
  }
}

class NegativeFrozenError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NEGATIVE_FROZEN';
    this.exitCode = 4;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

class Engine {
  constructor({ ttl = 100, defaultLimit = 100000 } = {}) {
    this.ttl = ttl;
    this.defaultLimit = defaultLimit;
    this.clock = 0;
    this.auths = new Map();
    this.certificates = [];
    this.ledger = [];
    this.acks = [];
    this.lastHash = '0'.repeat(64);
  }

  auth(id) {
    if (!this.auths.has(id)) {
      this.auths.set(id, {
        id,
        status: 'INIT',
        frozen: 0,
        charged: 0,
        limit: this.defaultLimit,
        expiresAt: null,
        nextSeq: 1,
        history: new Map(),
        buffer: new Map(),
        candidate: 0,
      });
    }
    return this.auths.get(id);
  }

  ingest(msg) {
    if (typeof msg.ts === 'number' && msg.ts > this.clock) {
      this.clock = msg.ts;
      this.sweep();
    }
    const a = this.auth(msg.authId);
    const canon = stableStringify(msg);
    if (msg.seq < a.nextSeq) {
      const prev = a.history.get(msg.seq);
      if (prev !== undefined && prev === canon) {
        this.acks.push({ authId: msg.authId, seq: msg.seq, result: 'duplicate' });
        return;
      }
      throw new ConflictError(`auth ${msg.authId} seq ${msg.seq}: conflicting payload for applied frame`);
    }
    if (msg.seq > a.nextSeq) {
      const held = a.buffer.get(msg.seq);
      if (held) {
        if (held.canon === canon) {
          this.acks.push({ authId: msg.authId, seq: msg.seq, result: 'duplicate' });
          return;
        }
        throw new ConflictError(`auth ${msg.authId} seq ${msg.seq}: conflicting payload for buffered frame`);
      }
      a.buffer.set(msg.seq, { canon, msg });
      if (msg.type === 'complete') a.candidate = Math.max(a.candidate, msg.amount || 0);
      this.acks.push({ authId: msg.authId, seq: msg.seq, result: 'buffered' });
      return;
    }
    this.apply(a, msg, canon);
    while (a.buffer.has(a.nextSeq)) {
      const next = a.buffer.get(a.nextSeq);
      a.buffer.delete(a.nextSeq);
      this.apply(a, next.msg, next.canon);
    }
  }

  apply(a, msg, canon) {
    a.history.set(msg.seq, canon);
    const from = a.status;
    let rejected = false;
    const reject = (reason) => {
      rejected = true;
      this.reject(a, msg, reason);
    };
    switch (msg.type) {
      case 'hold': {
        if (a.status !== 'INIT') {
          reject('HOLD_ON_ACTIVE');
          break;
        }
        a.status = 'OPEN';
        a.frozen = msg.amount;
        if (typeof msg.limit === 'number') a.limit = msg.limit;
        a.expiresAt = (typeof msg.ts === 'number' ? msg.ts : this.clock) + this.ttl;
        this.certify('HOLD', a, msg, from, {});
        break;
      }
      case 'inc': {
        if (a.status !== 'OPEN') {
          reject('LATE_INC');
          break;
        }
        const room = Math.max(0, a.limit - a.frozen);
        const accepted = Math.min(msg.amount, room);
        const rejected = msg.amount - accepted;
        a.frozen += accepted;
        this.certify(rejected > 0 ? 'INC_PARTIAL' : 'INC', a, msg, from, { requested: msg.amount, accepted, rejected });
        break;
      }
      case 'dec': {
        if (a.status !== 'OPEN') {
          reject('LATE_DEC');
          break;
        }
        const next = a.frozen - msg.amount;
        if (next < 0 || next < a.candidate) {
          throw new NegativeFrozenError(
            `auth ${a.id} seq ${msg.seq}: dec ${msg.amount} would drop frozen to ${next} (candidate floor ${a.candidate})`,
          );
        }
        a.frozen = next;
        this.certify('DEC', a, msg, from, {});
        break;
      }
      case 'complete': {
        if (a.status !== 'OPEN') {
          reject('LATE_COMPLETE');
          break;
        }
        if (msg.amount > a.frozen) {
          throw new NegativeFrozenError(`auth ${a.id} seq ${msg.seq}: complete ${msg.amount} exceeds frozen ${a.frozen}`);
        }
        const released = a.frozen - msg.amount;
        a.charged += msg.amount;
        a.frozen = 0;
        a.status = 'COMPLETED';
        this.certify('COMPLETE', a, msg, from, { released });
        break;
      }
      case 'void': {
        if (a.status !== 'OPEN') {
          reject('LATE_VOID');
          break;
        }
        const released = a.frozen;
        a.frozen = 0;
        a.status = 'VOIDED';
        this.certify('VOID', a, msg, from, { released });
        break;
      }
      case 'reverse': {
        if (a.status !== 'COMPLETED') {
          reject('REVERSE_NOT_COMPLETED');
          break;
        }
        if (msg.amount > a.charged) {
          reject('REVERSE_EXCEEDS_CHARGED');
          break;
        }
        a.charged -= msg.amount;
        this.ledger.push({ kind: 'REVERSE', authId: a.id, seq: msg.seq, amount: msg.amount, ts: msg.ts ?? this.clock });
        this.certify('REVERSE', a, msg, from, {});
        break;
      }
      default:
        reject('UNKNOWN_TYPE');
    }
    a.nextSeq = msg.seq + 1;
    if (!rejected) this.acks.push({ authId: a.id, seq: msg.seq, result: 'applied' });
  }

  reject(a, msg, reason) {
    this.ledger.push({
      kind: 'EVIDENCE',
      reason,
      authId: a.id,
      seq: msg.seq,
      type: msg.type,
      amount: msg.amount,
      ts: msg.ts ?? this.clock,
    });
    this.acks.push({ authId: a.id, seq: msg.seq, result: `rejected:${reason}` });
  }

  sweep() {
    for (const a of this.auths.values()) {
      if (a.status === 'OPEN' && a.expiresAt !== null && a.expiresAt <= this.clock) {
        const released = a.frozen;
        a.frozen = 0;
        a.status = 'VOIDED';
        this.certify('AUTO_VOID', a, null, 'OPEN', { released });
      }
    }
  }

  certify(transition, a, msg, from, extra) {
    const entry = {
      index: this.certificates.length,
      authId: a.id,
      seq: msg ? msg.seq : null,
      type: msg ? msg.type : null,
      transition,
      from,
      to: a.status,
      frozen: a.frozen,
      charged: a.charged,
      ts: msg && typeof msg.ts === 'number' ? msg.ts : this.clock,
      ...extra,
      prevHash: this.lastHash,
    };
    entry.hash = crypto.createHash('sha256').update(entry.prevHash + '|' + stableStringify(entry)).digest('hex');
    this.lastHash = entry.hash;
    this.certificates.push(entry);
  }

  report() {
    const auths = {};
    for (const a of this.auths.values()) {
      auths[a.id] = {
        status: a.status,
        frozen: a.frozen,
        charged: a.charged,
        available: a.status === 'OPEN' ? a.limit - a.frozen : 0,
        limit: a.limit,
        expiresAt: a.expiresAt,
        nextSeq: a.nextSeq,
      };
    }
    return {
      clock: this.clock,
      auths,
      ledger: this.ledger,
      certificates: this.certificates,
      acks: this.acks,
    };
  }
}

module.exports = { Engine, ConflictError, NegativeFrozenError, stableStringify };
