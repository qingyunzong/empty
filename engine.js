'use strict';

const { TYPE } = require('./frame');
const { AppendOnlyLog } = require('./log');

class CrashError extends Error {
  constructor(point, index) {
    super(`simulated crash at ${point} on decision #${index}`);
    this.name = 'CrashError';
    this.point = point;
    this.index = index;
  }
}

const keyOf = (member, reqId) => `${member}#${reqId}`;

// Clearing-house quota-freeze engine.
//
// Processing pipeline per request (write-ahead logging):
//   plan -> [crash: before_state] -> append log -> [crash: after_log]
//        -> apply state -> build reply -> [crash: after_reply]
//
// Recovery replays the append-only log deterministically, so the recovered
// state and every regenerated reply are unique.
class Engine {
  constructor(opts = {}) {
    this.budget = opts.budget ?? 1000;
    this.ttl = opts.ttl ?? 100; // reservation lifetime in virtual ticks
    this.now = 0;               // virtual clock, advanced only by EXPIRE frames
    this.reservedActive = 0;
    this.committedTotal = 0;
    this.reservations = new Map();   // key -> {member, reqId, remaining, granted, expiresAt, status}
    this.seenReserve = new Map();    // key -> original reply (business-level dedup)
    this.pendingRelease = new Map(); // key -> amount released before its reserve arrived
    this.exitFlags = new Set();      // 'over_budget' | 'unknown_req'
    this.log = new AppendOnlyLog();
    this.replies = [];
    this.recoveredReplies = new Map(); // `${member}#${seq}` -> reply (used after recovery)
    this.crashAt = opts.crashAt ?? -1;
    this.crashPoint = opts.crashPoint ?? null;
  }

  budgetLeft() {
    return this.budget - this.reservedActive - this.committedTotal;
  }

  // Deterministic tie-break: ordered by tick, then amount; requests with equal
  // amount at equal tick are settled by member (lexicographic) then reqId.
  static comparePriority(a, b) {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.amount !== b.amount) return a.amount - b.amount;
    if (a.member !== b.member) return a.member < b.member ? -1 : 1;
    return a.reqId - b.reqId;
  }

  maybeCrash(point, index) {
    if (this.crashPoint === point && this.crashAt === index) throw new CrashError(point, index);
  }

  // ---------------------------------------------------------------- planning

  plan(frame) {
    switch (frame.type) {
      case TYPE.RESERVE: return this.planReserve(frame);
      case TYPE.COMMIT: return this.planCommit(frame);
      case TYPE.RELEASE: return this.planRelease(frame);
      case TYPE.EXPIRE: return this.planExpire(frame);
      default: throw new Error(`unexpected frame type ${frame.type}`);
    }
  }

  planReserve(f) {
    const key = keyOf(f.member, f.reqId);
    if (this.seenReserve.has(key)) return { dupReply: this.seenReserve.get(key) };
    const want = f.amount;
    const granted = Math.min(want, Math.max(0, this.budgetLeft()));
    const decision = granted === want ? 'accept' : granted === 0 ? 'reject' : 'partial';
    const pendRel = Math.min(this.pendingRelease.get(key) || 0, granted);
    return {
      rec: {
        op: 'RESERVE', member: f.member, reqId: f.reqId, seq: f.seq, tick: this.now,
        want, granted, decision, expiresAt: this.now + this.ttl, pendRel,
      },
    };
  }

  planCommit(f) {
    const key = keyOf(f.member, f.reqId);
    const res = this.reservations.get(key);
    const base = { op: 'COMMIT', member: f.member, reqId: f.reqId, seq: f.seq, tick: this.now, want: f.amount };
    if (!res) return { rec: { ...base, decision: 'reject', reason: 'unknown-reqId', consumed: 0 } };
    if (res.status === 'committed') return { rec: { ...base, decision: 'accept', reason: 'duplicate', consumed: 0 } };
    if (res.status !== 'active') return { rec: { ...base, decision: 'reject', reason: res.status, consumed: 0 } };
    const consumed = Math.min(f.amount, res.remaining);
    return { rec: { ...base, decision: 'accept', consumed } };
  }

  planRelease(f) {
    const key = keyOf(f.member, f.reqId);
    const res = this.reservations.get(key);
    const base = { op: 'RELEASE', member: f.member, reqId: f.reqId, seq: f.seq, tick: this.now, want: f.amount };
    if (!res) {
      if (this.seenReserve.has(key)) return { rec: { ...base, decision: 'accept', released: 0, reason: 'already-closed' } };
      return { rec: { ...base, decision: 'buffered', released: 0 } };
    }
    if (res.status !== 'active') return { rec: { ...base, decision: 'accept', released: 0, reason: 'already-closed' } };
    const released = Math.min(f.amount, res.remaining);
    return { rec: { ...base, decision: 'accept', released } };
  }

  planExpire(f) {
    const target = f.amount;
    const base = { op: 'EXPIRE', member: f.member, reqId: f.reqId, seq: f.seq, tick: this.now, from: this.now, to: Math.max(target, this.now) };
    if (target <= this.now) return { rec: { ...base, decision: 'accept', events: [] } };
    const due = [];
    for (const res of this.reservations.values()) {
      if (res.status === 'active' && res.expiresAt <= target) {
        due.push({ member: res.member, reqId: res.reqId, amount: res.remaining, tick: res.expiresAt });
      }
    }
    due.sort(Engine.comparePriority);
    return { rec: { ...base, decision: 'accept', events: due.map((d) => ({ member: d.member, reqId: d.reqId, released: d.amount })) } };
  }

  // ------------------------------------------------------------- state apply

  applyRecord(rec) {
    switch (rec.op) {
      case 'RESERVE': {
        if (rec.granted > 0) {
          const res = {
            member: rec.member, reqId: rec.reqId, remaining: rec.granted,
            granted: rec.granted, expiresAt: rec.expiresAt, status: 'active',
          };
          this.reservations.set(keyOf(rec.member, rec.reqId), res);
          this.reservedActive += rec.granted;
          if (rec.pendRel > 0) {
            res.remaining -= rec.pendRel;
            this.reservedActive -= rec.pendRel;
            if (res.remaining === 0) res.status = 'released';
          }
        }
        if (rec.pendRel > 0) this.pendingRelease.delete(keyOf(rec.member, rec.reqId));
        if (rec.granted === 0 && rec.want > 0) this.exitFlags.add('over_budget');
        break;
      }
      case 'COMMIT': {
        if (rec.reason === 'unknown-reqId') this.exitFlags.add('unknown_req');
        if (rec.consumed > 0) {
          const res = this.reservations.get(keyOf(rec.member, rec.reqId));
          res.remaining -= rec.consumed;
          this.reservedActive -= rec.consumed;
          this.committedTotal += rec.consumed;
          if (res.remaining === 0) res.status = 'committed';
        }
        break;
      }
      case 'RELEASE': {
        if (rec.decision === 'buffered') {
          const key = keyOf(rec.member, rec.reqId);
          this.pendingRelease.set(key, (this.pendingRelease.get(key) || 0) + rec.want);
        } else if (rec.released > 0) {
          const res = this.reservations.get(keyOf(rec.member, rec.reqId));
          res.remaining -= rec.released;
          this.reservedActive -= rec.released;
          if (res.remaining === 0) res.status = 'released';
        }
        break;
      }
      case 'EXPIRE': {
        this.now = rec.to;
        for (const ev of rec.events) {
          const res = this.reservations.get(keyOf(ev.member, ev.reqId));
          res.remaining -= ev.released;
          this.reservedActive -= ev.released;
          if (res.remaining === 0) res.status = 'expired';
        }
        break;
      }
      default:
        throw new Error(`unknown record op ${rec.op}`);
    }
  }

  // ----------------------------------------------------------------- replies

  replyFromRecord(rec) {
    const got = rec.op === 'RESERVE' ? rec.granted
      : rec.op === 'COMMIT' ? rec.consumed
        : rec.op === 'RELEASE' ? rec.released : 0;
    return {
      op: rec.op, member: rec.member, reqId: rec.reqId, decision: rec.decision,
      want: rec.want ?? 0, got, reason: rec.reason,
      budget: this.budgetLeft(), now: this.now, events: rec.events,
    };
  }

  finalizeRecord(rec) {
    this.applyRecord(rec);
    const reply = this.replyFromRecord(rec);
    if (rec.op === 'RESERVE') this.seenReserve.set(keyOf(rec.member, rec.reqId), reply);
    this.replies.push(reply);
    return { ...reply, merkle: this.log.root() };
  }

  process(frame) {
    const planned = this.plan(frame);
    if (planned.dupReply) return { ...planned.dupReply, dup: true, merkle: this.log.root() };
    const index = this.log.length;
    this.maybeCrash('before_state', index);
    const rec = this.log.append(planned.rec);
    this.maybeCrash('after_log', index);
    const reply = this.finalizeRecord(rec);
    this.maybeCrash('after_reply', index);
    return reply;
  }

  // Rebuild an engine purely from persisted log records. Deterministic, so the
  // recovered state is unique regardless of where the crash happened.
  static recover(opts) {
    const eng = new Engine({ budget: opts.budget, ttl: opts.ttl });
    for (const rec of opts.records || []) {
      eng.log.append(rec);
      const reply = eng.finalizeRecord(rec);
      eng.recoveredReplies.set(`${rec.member}#${rec.seq}`, reply);
    }
    return eng;
  }

  finalize() {
    if (this.pendingRelease.size > 0) this.exitFlags.add('unknown_req');
  }
}

module.exports = { Engine, CrashError, keyOf };
