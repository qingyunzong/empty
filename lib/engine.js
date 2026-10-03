'use strict';

const { canonical, validateFrame } = require('./frame');

// Exit-code-carrying error: 2 mac, 3 conflict, 4 negative frozen, 1 other.
class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

const TERMINAL = new Set(['COMPLETED', 'VOIDED', 'REVERSED']);

class AuthState {
  constructor(authId) {
    this.authId = authId;
    this.status = 'INIT'; // INIT -> ACTIVE -> COMPLETED | VOIDED | REVERSED
    this.frozen = 0;      // 冻结
    this.charged = 0;     // 已扣
    this.nextSeq = 1;
    this.expiresAt = null; // virtual-clock tick at/after which hold is stale
    this.seen = new Map();    // seq -> canonical payload (dedup / conflict)
    this.buffer = new Map();  // seq -> frame (out-of-order gap buffer)
    this.ledger = [];         // money movements (流水)
    this.certificate = [];    // 状态迁移证书
  }

  // Floor imposed by complete frames already received but parked in the
  // gap buffer: dec may never push frozen below a known completion candidate.
  completionFloor() {
    let floor = 0;
    for (const f of this.buffer.values()) {
      if (f.type === 'complete' && f.amount > floor) floor = f.amount;
    }
    return floor;
  }
}

class Engine {
  constructor({ limit = 100000, ttl = 100 } = {}) {
    this.limit = limit;
    this.ttl = ttl;
    this.clock = 0; // virtual clock: +1 per ingested frame
    this.auths = new Map();
  }

  getAuth(authId) {
    let a = this.auths.get(authId);
    if (!a) {
      a = new AuthState(authId);
      this.auths.set(authId, a);
    }
    return a;
  }

  ingest(record) {
    if (!record.macOk) {
      throw new EngineError(2, `mac mismatch at stream offset ${record.offset}`);
    }
    const frame = record.frame;
    const bad = validateFrame(frame);
    if (bad) throw new EngineError(1, `invalid frame at offset ${record.offset}: ${bad}`);

    this.clock += 1;
    this.expireHolds();

    const auth = this.getAuth(frame.authId);
    const payload = canonical(frame);

    if (auth.seen.has(frame.seq)) {
      if (auth.seen.get(frame.seq) !== payload) {
        throw new EngineError(3,
          `conflict on ${frame.authId}#${frame.seq}: retransmission payload differs`);
      }
      this.cert(auth, frame, 'duplicate', { note: 'same seq, same payload: idempotent skip' });
      return;
    }
    auth.seen.set(frame.seq, payload);

    if (frame.seq > auth.nextSeq) {
      auth.buffer.set(frame.seq, frame);
      this.cert(auth, frame, 'buffered', { note: `gap: waiting for seq ${auth.nextSeq}` });
      return;
    }

    this.apply(auth, frame);
    while (auth.buffer.has(auth.nextSeq)) {
      const next = auth.buffer.get(auth.nextSeq);
      auth.buffer.delete(auth.nextSeq);
      this.apply(auth, next);
    }
  }

  expireHolds() {
    for (const auth of this.auths.values()) {
      if (auth.status === 'ACTIVE' && this.clock > auth.expiresAt) {
        const from = auth.status;
        const released = auth.frozen;
        auth.frozen = 0;
        auth.status = 'VOIDED';
        auth.ledger.push(this.ledgerEntry(auth, null, 'auto_void', released));
        auth.certificate.push({
          clock: this.clock, seq: null, authId: auth.authId, event: 'auto_void',
          from, to: auth.status, frozen: auth.frozen, charged: auth.charged,
          note: `hold expired at tick ${auth.expiresAt}; released ${released}`,
        });
      }
    }
  }

  apply(auth, frame) {
    const from = auth.status;
    const done = (event, extra = {}) => {
      auth.nextSeq += 1;
      this.cert(auth, frame, event, { from, ...extra });
      if (auth.frozen < 0) {
        throw new EngineError(4, `negative frozen on ${auth.authId} after seq ${frame.seq}`);
      }
    };
    const reject = (note) => done('rejected', { note });

    switch (frame.type) {
      case 'hold': {
        if (auth.status !== 'INIT') return reject(`hold requires INIT, got ${auth.status}`);
        if (frame.amount === 0) return reject('hold amount must be > 0');
        if (frame.amount > this.limit) return reject(`hold ${frame.amount} exceeds limit ${this.limit}`);
        auth.frozen = frame.amount;
        auth.status = 'ACTIVE';
        auth.expiresAt = this.clock + this.ttl;
        auth.ledger.push(this.ledgerEntry(auth, frame, 'hold', frame.amount));
        return done('hold', { amount: frame.amount, note: `expires at tick ${auth.expiresAt}` });
      }
      case 'inc': {
        if (auth.status !== 'ACTIVE') return reject(this.lateNote(auth, 'inc'));
        const room = Math.max(0, this.limit - auth.frozen - auth.charged);
        const accepted = Math.min(frame.amount, room);
        if (accepted > 0) {
          auth.frozen += accepted;
          auth.ledger.push(this.ledgerEntry(auth, frame, 'inc', accepted));
        }
        if (accepted === frame.amount) return done('inc', { amount: accepted });
        if (accepted === 0) return reject(`inc ${frame.amount} fully rejected: limit ${this.limit} reached`);
        return done('inc_partial', {
          amount: accepted, rejectedAmount: frame.amount - accepted,
          note: `inc ${frame.amount} partially accepted ${accepted}: limit ${this.limit}`,
        });
      }
      case 'dec': {
        if (auth.status !== 'ACTIVE') return reject(this.lateNote(auth, 'dec'));
        const floor = auth.completionFloor();
        const allowed = Math.max(0, auth.frozen - floor);
        const applied = Math.min(frame.amount, allowed);
        if (applied > 0) {
          auth.frozen -= applied;
          auth.ledger.push(this.ledgerEntry(auth, frame, 'dec', applied));
        }
        if (applied === frame.amount) return done('dec', { amount: applied });
        if (applied === 0) {
          return reject(`dec ${frame.amount} rejected: frozen ${auth.frozen} pinned by completion candidate ${floor}`);
        }
        return done('dec_partial', {
          amount: applied, rejectedAmount: frame.amount - applied,
          note: `dec ${frame.amount} clamped to ${applied}: completion candidate floor ${floor}`,
        });
      }
      case 'complete': {
        if (auth.status !== 'ACTIVE') return reject(this.lateNote(auth, 'complete'));
        if (frame.amount > auth.frozen) {
          throw new EngineError(4,
            `complete ${frame.amount} exceeds frozen ${auth.frozen} on ${auth.authId}#${frame.seq}: negative frozen`);
        }
        auth.charged += frame.amount;
        auth.frozen -= frame.amount;
        const released = auth.frozen;
        auth.frozen = 0;
        auth.status = 'COMPLETED';
        auth.ledger.push(this.ledgerEntry(auth, frame, 'complete', frame.amount));
        if (released > 0) auth.ledger.push(this.ledgerEntry(auth, frame, 'release', released));
        return done('complete', { amount: frame.amount, note: `charged ${frame.amount}, released ${released}` });
      }
      case 'void': {
        if (auth.status !== 'ACTIVE') return reject(this.lateNote(auth, 'void'));
        const released = auth.frozen;
        auth.frozen = 0;
        auth.status = 'VOIDED';
        auth.ledger.push(this.ledgerEntry(auth, frame, 'void', released));
        return done('void', { amount: released, note: `released ${released}` });
      }
      case 'reverse': {
        if (auth.status !== 'COMPLETED') return reject(`reverse requires COMPLETED, got ${auth.status}`);
        if (frame.amount !== auth.charged) {
          return reject(`reverse ${frame.amount} != charged ${auth.charged}: full reversal only`);
        }
        auth.charged = 0;
        auth.status = 'REVERSED';
        auth.ledger.push(this.ledgerEntry(auth, frame, 'reverse', frame.amount));
        return done('reverse', { amount: frame.amount, note: 'reversal ledger entry generated' });
      }
      default:
        return reject(`unknown type ${frame.type}`);
    }
  }

  lateNote(auth, type) {
    if (TERMINAL.has(auth.status)) return `late ${type}: auth already ${auth.status}`;
    return `${type} requires ACTIVE, got ${auth.status}`;
  }

  ledgerEntry(auth, frame, kind, amount) {
    return {
      clock: this.clock,
      seq: frame ? frame.seq : null,
      kind,
      amount,
      frozenAfter: auth.frozen,
      chargedAfter: auth.charged,
    };
  }

  cert(auth, frame, event, extra = {}) {
    auth.certificate.push({
      clock: this.clock,
      seq: frame ? frame.seq : null,
      authId: auth.authId,
      event,
      from: extra.from || auth.status,
      to: auth.status,
      frozen: auth.frozen,
      charged: auth.charged,
      ...(extra.amount !== undefined ? { amount: extra.amount } : {}),
      ...(extra.rejectedAmount !== undefined ? { rejectedAmount: extra.rejectedAmount } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    });
  }

  report() {
    const auths = {};
    for (const id of [...this.auths.keys()].sort()) {
      const a = this.auths.get(id);
      auths[id] = {
        authId: id,
        status: a.status,
        frozen: a.frozen,
        charged: a.charged,
        available: this.limit - a.frozen - a.charged, // 可再授权
        ack: a.nextSeq - 1, // highest contiguous applied seq
        expiresAt: a.expiresAt,
        ledger: a.ledger,
        certificate: a.certificate,
      };
    }
    return { clock: this.clock, limit: this.limit, ttl: this.ttl, auths };
  }
}

module.exports = { Engine, EngineError };
