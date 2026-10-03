'use strict';

const { TYPE, TYPE_NAME } = require('./frame');

// Deterministic reservation priority: smaller amount first, then member in
// lexicographic (code-unit) order, then reqId. Applied to all reserves of the
// same virtual tick; decisions are never revised afterwards.
function priorityCmp(a, b) {
  return (a.amount - b.amount) ||
    (a.member < b.member ? -1 : a.member > b.member ? 1 : 0) ||
    (a.reqId - b.reqId);
}

const bySeq = (a, b) => a.seq - b.seq;

class Engine {
  constructor({ budgetCap, ttl = 100, log, emit = () => {}, crashHook = () => {} }) {
    if (!Number.isInteger(budgetCap) || budgetCap < 0) throw new RangeError('budgetCap must be a non-negative integer');
    if (!Number.isInteger(ttl) || ttl < 0) throw new RangeError('ttl must be a non-negative integer');
    this.budgetCap = budgetCap;
    this.ttl = ttl;
    this.log = log;
    this.emit = emit;
    this.crashHook = crashHook;

    this.used = 0;                 // committed (permanently spent) budget
    this.reservations = new Map(); // reqId -> { member, remaining, expireTick, status }
    this.reserveDecisions = new Map(); // reqId -> cached reserve decision (idempotent replay)
    this.commitDecisions = new Map();  // `${reqId}:${amount}` -> cached commit decision
    this.knownReqIds = new Set();  // every reqId ever seen on a reserve
    this.parked = new Map();       // reqId -> [frames] arrived before their reserve
    this.currentBatch = [];
    this.currentTick = null;
    this.reqCount = 0;
    this.firstError = 0;           // first exit-code-worthy condition (3 or 4)
    this.processedSeqs = new Set();
  }

  reservedTotal() {
    let total = 0;
    for (const r of this.reservations.values()) if (r.status === 'active') total += r.remaining;
    return total;
  }

  remainingBudget() {
    return this.budgetCap - this.used - this.reservedTotal();
  }

  // ---- intake ----------------------------------------------------------

  ingest(frame) {
    if (this.processedSeqs.has(frame.seq)) return; // already decided (recovery replay)
    if (this.currentTick === null) this.currentTick = frame.tick;
    if (frame.tick > this.currentTick) {
      this._flushBatch();
      this.currentTick = frame.tick;
    }
    // Late frames (tick behind the clock) are clamped to the current tick so
    // the virtual clock never moves backwards.
    const tick = frame.tick < this.currentTick ? this.currentTick : frame.tick;
    this.currentBatch.push({ ...frame, tick });
  }

  flush() {
    this._flushBatch();
    const leftover = [...this.parked.values()].flat().sort(bySeq);
    this.parked.clear();
    for (const frame of leftover) this._rejectUnknown(frame);
  }

  _flushBatch() {
    if (!this.currentBatch.length) return;
    const tick = this.currentTick;
    const batch = this.currentBatch;
    this.currentBatch = [];
    // 1. TTL expiry fires before any request of this tick is judged.
    for (const [reqId, r] of [...this.reservations]) {
      if (r.status === 'active' && r.expireTick <= tick) this._expireReservation(reqId, tick);
    }
    // 2. Explicit expire requests, in link order.
    for (const f of batch.filter((x) => x.type === TYPE.EXPIRE).sort(bySeq)) this._expireRequest(f);
    // 3. Reserves compete by the deterministic priority rule.
    for (const f of batch.filter((x) => x.type === TYPE.RESERVE).sort(priorityCmp)) this._reserve(f);
    // 4. Commits and releases in link order.
    for (const f of batch.filter((x) => x.type === TYPE.COMMIT || x.type === TYPE.RELEASE).sort(bySeq)) this._dispatchOp(f);
  }

  // ---- request pipeline: mutate state -> append log -> emit response ----
  // Crash hooks fire at the three crash points: 'pre' (before the state
  // change), 'log' (after the log append), 'ack' (after the response).

  _beginRequest(frame) {
    const n = ++this.reqCount;
    this.crashHook('pre', n, frame);
    return n;
  }

  _finishRequest(frame, n, fields) {
    if (frame.seq != null) this.processedSeqs.add(frame.seq);
    const entry = this.log.append({ n, ...fields });
    this.crashHook('log', n, frame);
    this.emit(entry);
    this.crashHook('ack', n, frame);
    return entry;
  }

  _markError(code) {
    if (!this.firstError) this.firstError = code;
  }

  // ---- reserve ----------------------------------------------------------

  _reserve(f) {
    const n = this._beginRequest(f);
    this.knownReqIds.add(f.reqId);
    const prior = this.reserveDecisions.get(f.reqId);
    let fields;
    if (prior) {
      // Retransmission of an already-judged reserve: replay the cached
      // decision, never re-judge.
      fields = prior.member !== f.member
        ? { status: 'reject', reason: 'member-mismatch', granted: 0 }
        : { status: prior.status, granted: prior.granted, expireTick: prior.expireTick, dup: true };
    } else if (f.amount <= 0) {
      fields = { status: 'reject', reason: 'invalid-amount', granted: 0 };
      this.reserveDecisions.set(f.reqId, { member: f.member, status: 'reject', reason: 'invalid-amount', granted: 0, expireTick: null });
    } else {
      const granted = Math.min(f.amount, this.remainingBudget());
      const status = granted === 0 ? 'reject' : granted < f.amount ? 'partial' : 'accept';
      const expireTick = granted > 0 ? f.tick + this.ttl : null;
      if (granted > 0) {
        this.reservations.set(f.reqId, { member: f.member, remaining: granted, expireTick, status: 'active' });
      }
      if (status === 'reject') this._markError(3); // over budget
      fields = { status, granted, expireTick };
      if (status === 'reject') fields.reason = 'budget';
      this.reserveDecisions.set(f.reqId, { member: f.member, status, granted, expireTick, reason: fields.reason });
    }
    const entry = this._finishRequest(f, n, {
      kind: 'reserve', seq: f.seq, tick: f.tick, member: f.member, reqId: f.reqId,
      amount: f.amount, remainingBudget: this.remainingBudget(), ...fields,
    });
    if (!prior && fields.granted > 0) this._drainParked(f.reqId);
    return entry;
  }

  // ---- commit -----------------------------------------------------------

  _commit(f) {
    const key = `${f.reqId}:${f.amount}`;
    const cached = this.commitDecisions.get(key);
    const r = this.reservations.get(f.reqId);
    if (!cached && (!r || r.status !== 'active') && !this.knownReqIds.has(f.reqId)) {
      this._park(f);
      return null;
    }
    const n = this._beginRequest(f);
    let fields;
    if (cached) {
      // Identical commit seen before: idempotent replay, never double-spend.
      fields = { ...cached, dup: true };
    } else if (!r || r.status !== 'active') {
      fields = { status: 'reject', reason: r ? 'not-active' : 'no-reservation', committed: 0 };
    } else if (r.member !== f.member) {
      fields = { status: 'reject', reason: 'member-mismatch', committed: 0 };
    } else if (f.amount <= 0 || f.amount > r.remaining) {
      fields = { status: 'reject', reason: 'amount-exceeds-reserved', committed: 0 };
    } else {
      r.remaining -= f.amount;
      this.used += f.amount;
      if (r.remaining === 0) r.status = 'committed';
      fields = { status: 'accept', committed: f.amount };
    }
    const entry = this._finishRequest(f, n, {
      kind: 'commit', seq: f.seq, tick: f.tick, member: f.member, reqId: f.reqId,
      amount: f.amount, remainingBudget: this.remainingBudget(), ...fields,
    });
    if (!fields.dup) {
      this.commitDecisions.set(key, { status: fields.status, committed: fields.committed, reason: fields.reason });
    }
    return entry;
  }

  // ---- release ----------------------------------------------------------

  _release(f) {
    const r = this.reservations.get(f.reqId);
    if ((!r || r.status !== 'active') && !this.knownReqIds.has(f.reqId)) {
      this._park(f);
      return null;
    }
    const n = this._beginRequest(f);
    let fields;
    if (!r) {
      fields = { status: 'reject', reason: 'no-reservation', released: 0 };
    } else if (r.member !== f.member) {
      fields = { status: 'reject', reason: 'member-mismatch', released: 0 };
    } else if (r.status !== 'active') {
      fields = { status: 'accept', released: 0, noop: true }; // idempotent
    } else {
      fields = { status: 'accept', released: r.remaining };
      r.remaining = 0;
      r.status = 'released';
    }
    return this._finishRequest(f, n, {
      kind: 'release', seq: f.seq, tick: f.tick, member: f.member, reqId: f.reqId,
      amount: f.amount, remainingBudget: this.remainingBudget(), ...fields,
    });
  }

  // ---- expire -----------------------------------------------------------

  _expireRequest(f) {
    const r = this.reservations.get(f.reqId);
    if ((!r || r.status !== 'active') && !this.knownReqIds.has(f.reqId)) {
      this._park(f);
      return null;
    }
    const n = this._beginRequest(f);
    let fields;
    if (!r) {
      fields = { status: 'reject', reason: 'no-reservation', released: 0 };
    } else if (r.member !== f.member) {
      fields = { status: 'reject', reason: 'member-mismatch', released: 0 };
    } else if (r.status !== 'active') {
      fields = { status: 'accept', released: 0, noop: true };
    } else {
      fields = { status: 'accept', released: r.remaining };
      r.remaining = 0;
      r.status = 'expired';
    }
    return this._finishRequest(f, n, {
      kind: 'expire', seq: f.seq, tick: f.tick, member: f.member, reqId: f.reqId,
      amount: f.amount, auto: false, remainingBudget: this.remainingBudget(), ...fields,
    });
  }

  // TTL-driven expiry: engine-generated audit event, not a request.
  _expireReservation(reqId, tick) {
    const r = this.reservations.get(reqId);
    const released = r.remaining;
    r.remaining = 0;
    r.status = 'expired';
    const entry = this.log.append({
      n: null, kind: 'expire', seq: null, tick, member: r.member, reqId,
      amount: 0, status: 'accept', released, auto: true,
      remainingBudget: this.remainingBudget(),
    });
    this.emit(entry);
    return entry;
  }

  // ---- parked ops (arrived before their reserve) ------------------------

  _park(f) {
    let list = this.parked.get(f.reqId);
    if (!list) this.parked.set(f.reqId, (list = []));
    list.push(f);
  }

  _drainParked(reqId) {
    const list = this.parked.get(reqId);
    if (!list) return;
    this.parked.delete(reqId);
    for (const f of list.sort(bySeq)) this._dispatchOp(f);
  }

  _dispatchOp(f) {
    if (f.type === TYPE.COMMIT) return this._commit(f);
    if (f.type === TYPE.RELEASE) return this._release(f);
    if (f.type === TYPE.EXPIRE) return this._expireRequest(f);
    throw new Error(`cannot dispatch frame type ${f.type}`);
  }

  _rejectUnknown(f) {
    const n = this._beginRequest(f);
    this._markError(4); // unknown reqId
    this._finishRequest(f, n, {
      kind: TYPE_NAME[f.type], seq: f.seq, tick: f.tick, member: f.member, reqId: f.reqId,
      amount: f.amount, status: 'reject', reason: 'unknown-reqid',
      remainingBudget: this.remainingBudget(),
    });
  }

  // ---- recovery: replay logged decisions without re-judging -------------

  replay(entries) {
    for (const e of entries) {
      if (e.seq != null) this.processedSeqs.add(e.seq);
      if (typeof e.n === 'number') this.reqCount = Math.max(this.reqCount, e.n);
      if (typeof e.tick === 'number') {
        this.currentTick = this.currentTick === null ? e.tick : Math.max(this.currentTick, e.tick);
      }
      switch (e.kind) {
        case 'reserve': {
          this.knownReqIds.add(e.reqId);
          if (!e.dup) {
            this.reserveDecisions.set(e.reqId, {
              member: e.member, status: e.status, granted: e.granted,
              expireTick: e.expireTick ?? null, reason: e.reason,
            });
            if (e.granted > 0) {
              this.reservations.set(e.reqId, { member: e.member, remaining: e.granted, expireTick: e.expireTick, status: 'active' });
            }
            if (e.status === 'reject' && e.reason === 'budget') this._markError(3);
          }
          break;
        }
        case 'commit': {
          if (!e.dup) {
            this.commitDecisions.set(`${e.reqId}:${e.amount}`, {
              status: e.status, committed: e.committed, reason: e.reason,
            });
            if (e.status === 'accept') {
              const r = this.reservations.get(e.reqId);
              if (r && r.status === 'active') {
                r.remaining -= e.amount;
                this.used += e.amount;
                if (r.remaining === 0) r.status = 'committed';
              }
            }
          }
          break;
        }
        case 'release':
        case 'expire': {
          if (e.status === 'accept' && e.released > 0) {
            const r = this.reservations.get(e.reqId);
            if (r && r.status === 'active') {
              r.remaining = 0;
              r.status = e.kind === 'expire' ? 'expired' : 'released';
            }
          }
          break;
        }
        default:
          throw new Error(`unknown log entry kind ${e.kind}`);
      }
      if (e.reason === 'unknown-reqid') this._markError(4);
      this.emit(e);
    }
  }
}

module.exports = { Engine, priorityCmp };
