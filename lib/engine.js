'use strict';

const { FrameError } = require('./framing');

class StateConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateConflict';
    this.code = 'STATE_CONFLICT';
  }
}

const OP_TYPES = ['auth', 'capture', 'void', 'refund', 'reversal'];

function canonical(msg) {
  return JSON.stringify({
    type: msg.type,
    amount: msg.amount ?? null,
    ref: msg.ref ?? null,
    seq: msg.seq ?? null,
    ts: msg.ts ?? null,
  });
}

function validateFrame(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new FrameError('frame must be a JSON object');
  }
  if (msg.type === 'tick') {
    if (typeof msg.ts !== 'number' || !(msg.ts >= 0)) {
      throw new FrameError('tick frame requires numeric ts >= 0');
    }
    return;
  }
  if (!OP_TYPES.includes(msg.type)) {
    throw new FrameError(`unknown op type: ${String(msg.type)}`);
  }
  if (typeof msg.idemKey !== 'string' || msg.idemKey === '') {
    throw new FrameError('frame requires non-empty string idemKey');
  }
  if (!Number.isInteger(msg.seq) || msg.seq < 0) {
    throw new FrameError('frame requires integer seq >= 0');
  }
  if (typeof msg.ts !== 'number' || !(msg.ts >= 0)) {
    throw new FrameError('frame requires numeric ts >= 0');
  }
  if (msg.type === 'auth' || msg.type === 'capture' || msg.type === 'refund') {
    if (typeof msg.amount !== 'number' || !Number.isFinite(msg.amount) || !(msg.amount > 0)) {
      throw new FrameError(`${msg.type} requires positive finite amount`);
    }
  }
  if (msg.type !== 'auth') {
    if (typeof msg.ref !== 'string' || msg.ref === '') {
      throw new FrameError(`${msg.type} requires non-empty string ref`);
    }
  }
}

// Single-account card transaction engine.
//
// Credit lifecycle: auth freezes, capture deducts (releasing the uncaptured
// remainder of the hold), void/refund/reversal release. Available credit is
// invariant: 0 <= available <= creditLimit.
//
// Reversal is append-only: a compensating event is appended to the ledger,
// the original event is never deleted.
//
// Crash model: the WAL record is written (fsync'd) before the response is
// returned. On restart the WAL is replayed; a re-sent request hits the
// idempotency table and the stored response is returned without re-applying.
class Engine {
  constructor({ creditLimit = 1000, authTtlMs = 30000, wal = null } = {}) {
    this.creditLimit = creditLimit;
    this.available = creditLimit;
    this.authTtlMs = authTtlMs;
    this.wal = wal;
    this.now = 0;
    this.auths = new Map(); // authKey -> {amount, remaining, captured, status, expiresAt}
    this.captures = new Map(); // captureKey -> {authKey, amount, refunded, reversed}
    this.idem = new Map(); // idemKey -> {payload, response}
    this.pending = new Map(); // refKey -> [{idemKey, msg}] out-of-order buffer
    this.ledger = []; // applied events, in order
    if (this.wal) {
      for (const rec of this.wal.records()) this._replay(rec);
    }
  }

  apply(msg) {
    validateFrame(msg);
    if (msg.type === 'tick') {
      this._advanceClock(msg.ts);
      const response = { status: 'ok', type: 'tick', now: this.now };
      if (this.wal) this.wal.append({ event: null, idemKey: null, request: null, response, now: this.now });
      return response;
    }
    const key = msg.idemKey;
    const seen = this.idem.get(key);
    if (seen) {
      if (seen.payload === canonical(msg)) {
        return Object.assign({ duplicate: true }, seen.response);
      }
      throw new StateConflict(`idemKey "${key}" reused with a different payload`);
    }
    this._advanceClock(msg.ts);
    return this._process(msg);
  }

  _process(msg) {
    const key = msg.idemKey;
    switch (msg.type) {
      case 'auth': {
        if (this.available < msg.amount) {
          throw new StateConflict(
            `insufficient credit: need ${msg.amount}, available ${this.available}`
          );
        }
        const event = {
          type: 'auth', idem: key, key, amount: msg.amount,
          expiresAt: this.now + this.authTtlMs, ts: this.now,
        };
        return this._commit(event, key, msg);
      }
      case 'capture': {
        const auth = this.auths.get(msg.ref);
        if (!auth) return this._buffer(msg);
        if (auth.status !== 'open') {
          throw new StateConflict(`capture rejected: auth "${msg.ref}" is ${auth.status}`);
        }
        if (msg.amount > auth.remaining) {
          throw new StateConflict(
            `capture amount ${msg.amount} exceeds remaining hold ${auth.remaining}`
          );
        }
        const event = {
          type: 'capture', idem: key, key, ref: msg.ref, amount: msg.amount, ts: this.now,
        };
        return this._commit(event, key, msg);
      }
      case 'void': {
        const auth = this.auths.get(msg.ref);
        if (!auth) return this._buffer(msg);
        if (auth.status !== 'open') {
          throw new StateConflict(`void rejected: auth "${msg.ref}" is ${auth.status}`);
        }
        const event = {
          type: 'void', idem: key, key: msg.ref, ref: msg.ref, amount: auth.remaining, ts: this.now,
        };
        return this._commit(event, key, msg);
      }
      case 'refund': {
        const capture = this.captures.get(msg.ref);
        if (!capture) return this._buffer(msg);
        if (capture.reversed) {
          throw new StateConflict(`refund rejected: capture "${msg.ref}" was reversed`);
        }
        if (capture.refunded + msg.amount > capture.amount) {
          throw new StateConflict(
            `refund ${msg.amount} exceeds remaining capturable ` +
            `${capture.amount - capture.refunded} of capture "${msg.ref}"`
          );
        }
        const event = {
          type: 'refund', idem: key, key, ref: msg.ref, amount: msg.amount, ts: this.now,
        };
        return this._commit(event, key, msg);
      }
      case 'reversal': {
        const capture = this.captures.get(msg.ref);
        if (capture) {
          if (capture.reversed) {
            throw new StateConflict(`reversal rejected: capture "${msg.ref}" already reversed`);
          }
          const event = {
            type: 'reversal', idem: key, key, ref: msg.ref, on: 'capture',
            amount: capture.amount - capture.refunded, ts: this.now,
          };
          return this._commit(event, key, msg);
        }
        const auth = this.auths.get(msg.ref);
        if (!auth) return this._buffer(msg);
        if (auth.status !== 'open') {
          throw new StateConflict(`reversal rejected: auth "${msg.ref}" is ${auth.status}`);
        }
        const event = {
          type: 'reversal', idem: key, key, ref: msg.ref, on: 'auth',
          amount: auth.remaining, ts: this.now,
        };
        return this._commit(event, key, msg);
      }
      default:
        throw new FrameError(`unknown op type: ${String(msg.type)}`);
    }
  }

  _commit(event, idemKey, request) {
    this._applyEvent(event);
    this.ledger.push(event);
    const response = {
      status: 'ok', type: request.type, idemKey, available: this.available,
    };
    if (this.wal) this.wal.append({ event, idemKey, request, response, now: this.now });
    this.idem.set(idemKey, { payload: canonical(request), response });
    this._flush(event.idem);
    return response;
  }

  _buffer(msg) {
    const key = msg.idemKey;
    const response = { status: 'buffered', idemKey: key, waitingFor: msg.ref };
    if (this.wal) this.wal.append({ event: null, idemKey: key, request: msg, response, now: this.now });
    this.idem.set(key, { payload: canonical(msg), response });
    const list = this.pending.get(msg.ref) || [];
    list.push({ idemKey: key, msg });
    this.pending.set(msg.ref, list);
    return response;
  }

  _flush(key) {
    const list = this.pending.get(key);
    if (!list) return;
    this.pending.delete(key);
    for (const p of list) this._process(p.msg);
  }

  _advanceClock(ts) {
    if (typeof ts === 'number' && ts > this.now) this.now = ts;
    for (const [key, auth] of this.auths) {
      if (auth.status === 'open' && auth.expiresAt <= this.now) {
        const event = { type: 'auto-void', key, ref: key, amount: auth.remaining, ts: this.now };
        this._applyEvent(event);
        this.ledger.push(event);
        if (this.wal) this.wal.append({ event, idemKey: null, request: null, response: null, now: this.now });
      }
    }
  }

  _applyEvent(ev) {
    switch (ev.type) {
      case 'auth': {
        this.auths.set(ev.key, {
          amount: ev.amount, remaining: ev.amount, captured: 0,
          status: 'open', expiresAt: ev.expiresAt,
        });
        this.available -= ev.amount;
        break;
      }
      case 'capture': {
        const auth = this.auths.get(ev.ref);
        auth.remaining -= ev.amount;
        this.available += auth.remaining; // release uncaptured remainder
        auth.remaining = 0;
        auth.captured = ev.amount;
        auth.status = 'captured';
        this.captures.set(ev.key, {
          authKey: ev.ref, amount: ev.amount, refunded: 0, reversed: false,
        });
        break;
      }
      case 'void':
      case 'auto-void': {
        const auth = this.auths.get(ev.ref);
        this.available += ev.amount;
        auth.remaining = 0;
        auth.status = ev.type === 'auto-void' ? 'expired' : 'voided';
        break;
      }
      case 'refund': {
        const capture = this.captures.get(ev.ref);
        capture.refunded += ev.amount;
        this.available += ev.amount;
        break;
      }
      case 'reversal': {
        if (ev.on === 'capture') {
          const capture = this.captures.get(ev.ref);
          this.available += ev.amount;
          capture.reversed = true;
        } else {
          const auth = this.auths.get(ev.ref);
          this.available += ev.amount;
          auth.remaining = 0;
          auth.status = 'voided';
        }
        break;
      }
      default:
        throw new Error(`unknown event type: ${ev.type}`);
    }
    if (this.available < 0) {
      throw new Error(`invariant violated: available credit ${this.available} < 0`);
    }
    if (this.available > this.creditLimit) {
      throw new Error(`invariant violated: available credit ${this.available} > limit ${this.creditLimit}`);
    }
  }

  _replay(rec) {
    if (typeof rec.now === 'number' && rec.now > this.now) this.now = rec.now;
    if (rec.event) {
      this._applyEvent(rec.event);
      this.ledger.push(rec.event);
    }
    if (rec.idemKey) {
      this.idem.set(rec.idemKey, { payload: canonical(rec.request), response: rec.response });
      if (rec.response && rec.response.status === 'buffered') {
        const list = this.pending.get(rec.request.ref) || [];
        list.push({ idemKey: rec.idemKey, msg: rec.request });
        this.pending.set(rec.request.ref, list);
      } else {
        for (const [ref, list] of this.pending) {
          const kept = list.filter((p) => p.idemKey !== rec.idemKey);
          if (kept.length) this.pending.set(ref, kept);
          else this.pending.delete(ref);
        }
      }
    }
  }
}

module.exports = { Engine, StateConflict, canonical, validateFrame };
