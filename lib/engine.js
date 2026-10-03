'use strict';

const fs = require('node:fs');
const { FrameError } = require('./framer');

const TYPES = new Set(['auth', 'capture', 'void', 'refund', 'reversal']);
const REF_TYPES = new Set(['capture', 'void', 'refund', 'reversal']);

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

// Structural validation of a decoded frame. Violations are frame errors.
function validateMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new FrameError('frame is not a JSON object');
  }
  if (typeof msg.idemKey !== 'string' || msg.idemKey.length === 0) {
    throw new FrameError('missing or invalid idemKey');
  }
  if (!TYPES.has(msg.type)) {
    throw new FrameError('unknown type: ' + String(msg.type));
  }
  if (!Number.isInteger(msg.seq)) {
    throw new FrameError('seq must be an integer');
  }
  if (typeof msg.ts !== 'number' || !Number.isFinite(msg.ts)) {
    throw new FrameError('ts must be a finite number');
  }
  if (msg.type === 'auth') {
    if (typeof msg.amount !== 'number' || !(msg.amount > 0)) {
      throw new FrameError('auth requires amount > 0');
    }
    if (msg.ttl !== undefined && !(typeof msg.ttl === 'number' && msg.ttl > 0)) {
      throw new FrameError('ttl must be a positive number');
    }
  } else {
    if (msg.amount !== undefined && (typeof msg.amount !== 'number' || !(msg.amount >= 0))) {
      throw new FrameError('amount must be a number >= 0');
    }
  }
  if (REF_TYPES.has(msg.type)) {
    if (typeof msg.ref !== 'string' || msg.ref.length === 0) {
      throw new FrameError(msg.type + ' requires a ref field');
    }
  }
}

// Transaction engine: auth/capture/void/refund state machine, idempotent
// dedup, out-of-order buffering, virtual-clock auth expiry, append-only
// ledger with compensating reversal events, WAL-based crash recovery.
class Engine {
  constructor(opts = {}) {
    this.limit = opts.limit !== undefined ? opts.limit : 1000;
    this.ttl = opts.ttl !== undefined ? opts.ttl : 1000;
    this.walPath = opts.walPath || null;
    this.onAppend = opts.onAppend || null; // crash-injection hook
    this._reset();
    if (this.walPath) {
      if (opts.fresh) {
        fs.writeFileSync(this.walPath, '');
      } else if (fs.existsSync(this.walPath)) {
        this._recover();
      }
    }
  }

  _reset() {
    this.held = 0;          // frozen by open auths
    this.capturedTotal = 0; // net captured (net of refunds/reversals)
    this.now = 0;           // virtual clock: max ts ever seen
    this.auths = new Map();       // idemKey -> auth
    this.captures = new Map();    // capture idemKey -> capture
    this.captureByAuth = new Map();
    this.seen = new Map();        // idemKey -> { canon, reply }
    this.pending = new Map();     // ref -> [buffered msgs]
    this.ledger = [];             // append-only committed events
    this.rejected = [];           // { idemKey, reason }
    this.eventSeq = 0;
    this.walCount = 0;
  }

  _recover() {
    const text = fs.readFileSync(this.walPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const rec = JSON.parse(trimmed);
      if (typeof rec.t === 'number' && rec.t > this.now) this.now = rec.t;
      this._apply(rec.m, { replay: true, fromBuffer: false });
    }
  }

  available() {
    return this.limit - this.held - this.capturedTotal;
  }

  // Public entry: validate + apply one decoded message, return the reply.
  apply(msg) {
    validateMessage(msg);
    return this._apply(msg, { replay: false, fromBuffer: false });
  }

  _apply(msg, { replay, fromBuffer }) {
    const canon = stable(msg);
    if (!fromBuffer) {
      const prior = this.seen.get(msg.idemKey);
      if (prior) {
        if (prior.canon !== canon) {
          // Same idemKey, different payload: hard conflict. Does not
          // overwrite the original registration.
          if (!replay) this.rejected.push({ idemKey: msg.idemKey, reason: 'idem-key-conflict' });
          return { idemKey: msg.idemKey, status: 'rejected', reason: 'idem-key-conflict' };
        }
        // Exact resend: replay the stored reply, no re-application.
        return Object.assign({}, prior.reply, { duplicate: true });
      }
      // Advance the virtual clock, then auto-void expired auths.
      if (msg.ts > this.now) this.now = msg.ts;
      this._expire();
    }

    let reply;
    switch (msg.type) {
      case 'auth': reply = this._doAuth(msg, replay); break;
      case 'capture': reply = this._doCapture(msg, replay); break;
      case 'void': reply = this._doVoid(msg, replay); break;
      case 'refund': reply = this._doRefundLike(msg, replay, 'refund'); break;
      case 'reversal': reply = this._doRefundLike(msg, replay, 'reversal'); break;
    }

    if (reply.status === 'rejected') {
      // A rejection is a durable outcome: it advanced the virtual clock and
      // its reply must be re-emitted (not re-evaluated) after a crash, so it
      // is recorded in the WAL like any accepted message.
      this.rejected.push({ idemKey: msg.idemKey, reason: reply.reason });
      if (fromBuffer) {
        const entry = this.seen.get(msg.idemKey);
        if (entry) entry.reply = reply;
      } else {
        this._record(msg, replay);
        this.seen.set(msg.idemKey, { canon, reply });
      }
      return reply;
    }

    if (fromBuffer) {
      // Already WAL-recorded and registered at arrival; just update the
      // stored reply so future resends get the final outcome.
      const entry = this.seen.get(msg.idemKey);
      if (entry) entry.reply = reply;
    } else {
      // Crash point: WAL append happens here, before the reply is returned.
      this._record(msg, replay);
      this.seen.set(msg.idemKey, { canon, reply });
    }
    return reply;
  }

  _record(msg, replay) {
    if (!replay && this.walPath) {
      fs.appendFileSync(this.walPath, JSON.stringify({ t: this.now, m: msg }) + '\n');
    }
    this.walCount += 1;
    if (!replay && this.onAppend) this.onAppend(this.walCount);
  }

  _doAuth(msg, replay) {
    if (this.available() < msg.amount) {
      return { idemKey: msg.idemKey, status: 'rejected', reason: 'insufficient-credit' };
    }
    const auth = {
      key: msg.idemKey,
      amount: msg.amount,
      ts: msg.ts,
      ttl: msg.ttl !== undefined ? msg.ttl : this.ttl,
      status: 'OPEN',
      captured: 0,
    };
    this.auths.set(auth.key, auth);
    this.held += auth.amount;
    this._event('auth', msg, auth.amount);
    this._drain(auth.key, replay);
    return { idemKey: msg.idemKey, status: 'applied', available: this.available() };
  }

  _doCapture(msg, replay) {
    const auth = this.auths.get(msg.ref);
    if (!auth) return this._buffer(msg);
    if (auth.status !== 'OPEN') {
      return { idemKey: msg.idemKey, status: 'rejected', reason: 'auth-' + auth.status.toLowerCase() };
    }
    const amount = msg.amount !== undefined ? msg.amount : auth.amount;
    if (amount > auth.amount) {
      return { idemKey: msg.idemKey, status: 'rejected', reason: 'capture-exceeds-auth' };
    }
    this.held -= auth.amount; // release the full hold
    this.capturedTotal += amount;
    auth.status = 'CAPTURED';
    auth.captured = amount;
    const cap = { key: msg.idemKey, authKey: auth.key, amount, refunded: 0 };
    this.captures.set(cap.key, cap);
    this.captureByAuth.set(auth.key, cap);
    this._event('capture', msg, amount);
    this._drain(cap.key, replay);
    return { idemKey: msg.idemKey, status: 'applied', available: this.available() };
  }

  _doVoid(msg, replay) {
    const auth = this.auths.get(msg.ref);
    if (!auth) return this._buffer(msg);
    if (auth.status === 'VOID') {
      return { idemKey: msg.idemKey, status: 'rejected', reason: 'already-void' };
    }
    if (auth.status === 'CAPTURED') {
      return { idemKey: msg.idemKey, status: 'rejected', reason: 'already-captured' };
    }
    this.held -= auth.amount;
    auth.status = 'VOID';
    this._event('void', msg, auth.amount);
    return { idemKey: msg.idemKey, status: 'applied', available: this.available() };
  }

  _doRefundLike(msg, replay, kind) {
    const cap = this.captures.get(msg.ref) || this.captureByAuth.get(msg.ref) || null;
    if (!cap) {
      if (this.auths.has(msg.ref)) {
        return { idemKey: msg.idemKey, status: 'rejected', reason: 'not-captured' };
      }
      return this._buffer(msg); // target may arrive later (out-of-order)
    }
    const remaining = cap.amount - cap.refunded;
    const amount = msg.amount !== undefined ? msg.amount : remaining;
    if (amount > remaining) {
      return { idemKey: msg.idemKey, status: 'rejected', reason: kind + '-exceeds-capture' };
    }
    cap.refunded += amount;
    this.capturedTotal -= amount;
    // A reversal is a compensating event appended to the log; the original
    // capture event is never deleted.
    this._event(kind, msg, amount, kind === 'reversal' ? { compensating: true } : undefined);
    return { idemKey: msg.idemKey, status: 'applied', available: this.available() };
  }

  _buffer(msg) {
    if (!this.pending.has(msg.ref)) this.pending.set(msg.ref, []);
    this.pending.get(msg.ref).push(msg);
    return { idemKey: msg.idemKey, status: 'buffered', ref: msg.ref };
  }

  _drain(key, replay) {
    const list = this.pending.get(key);
    if (!list || list.length === 0) return;
    this.pending.delete(key);
    list.sort((a, b) => a.seq - b.seq);
    for (const m of list) this._apply(m, { replay, fromBuffer: true });
  }

  _expire() {
    for (const auth of this.auths.values()) {
      if (auth.status === 'OPEN' && auth.ts + auth.ttl <= this.now) {
        auth.status = 'VOID';
        this.held -= auth.amount;
        this._event('auto_void', { idemKey: auth.key, ref: null }, auth.amount);
      }
    }
  }

  _event(type, msg, amount, extra) {
    this.eventSeq += 1;
    const event = {
      n: this.eventSeq,
      ts: this.now,
      type,
      idemKey: msg.idemKey,
      ref: msg.ref !== undefined ? msg.ref : null,
      amount,
      available: this.available(),
    };
    if (extra) Object.assign(event, extra);
    this.ledger.push(event);
    if (this.held < 0 || this.capturedTotal < 0 || this.available() < 0) {
      throw new Error('credit invariant violated: negative balance');
    }
  }

  finalize() {
    const pending = [];
    for (const list of this.pending.values()) {
      for (const m of list) pending.push({ idemKey: m.idemKey, ref: m.ref });
    }
    return {
      limit: this.limit,
      held: this.held,
      captured: this.capturedTotal,
      available: this.available(),
      ledger: this.ledger,
      certificate: {
        // Committed events in commit order: a valid topological order of
        // the concurrent history. Rejected ops carry their reason.
        linearization: this.ledger.map((e) => ({ n: e.n, type: e.type, idemKey: e.idemKey })),
        rejected: this.rejected,
        pending,
      },
      conflicted: this.rejected.length > 0,
    };
  }
}

module.exports = { Engine, FrameError, validateMessage, stable };
