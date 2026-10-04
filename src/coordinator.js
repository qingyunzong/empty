'use strict';
const Wal = require('./wal');

// Coordinator. WAL records per tx:
//   begin    {ops:[{acct,amount}...]}   - before any prepare is sent
//   decision {decision, reason?}        - commit/abort, before notifying
//   done     {}                         - all participant acks received
// Prepare seq = 0, decision seq = 1 (per tx, per participant); retransmits
// reuse the same seq so receivers dedupe and replay cached replies.
class Coordinator {
  constructor(ctx) {
    this.ctx = ctx;
    this.id = 'c';
    this.wal = new Wal(ctx.walPath('c'), 'c');
    this.txs = new Map();
    this.seenVotes = new Set();
    this.crashed = false;
    if (this.wal.records.length) this.recover();
  }

  _newState(id, ops) {
    return { id, ops, votes: new Map(), decision: null, reason: null, acked: new Set(), done: false };
  }

  beginTx(spec) {
    if (this.crashed) {
      this.ctx.clock.schedule(1, 1, () => this.beginTx(spec));
      return;
    }
    const ops = [
      { acct: spec.from, amount: -spec.amount },
      { acct: spec.to, amount: spec.amount },
    ];
    this.wal.append({ tx: spec.id, type: 'begin', data: { ops } }, this.ctx.now());
    const st = this._newState(spec.id, ops);
    this.txs.set(spec.id, st);
    this.ctx.event(`begin tx=${spec.id} ${spec.from}->${spec.to} ${spec.amount}`);
    if (this.ctx.hook('c', spec.id, 'afterPrepareLog')) return;
    this._sendPrepares(st);
    this._armTimeout(st);
  }

  _sendPrepares(st) {
    for (const op of st.ops) {
      this.ctx.network.send('c', 'p:' + op.acct, { tx: st.id, phase: 'prepare', acct: op.acct, amount: op.amount, seq: 0, ack: 0 });
      this._armPrepareRetransmit(st, op);
    }
  }

  _armPrepareRetransmit(st, op) {
    this.ctx.clock.schedule(this.ctx.R, 1, () => {
      if (this.crashed || st.decision || st.votes.has(op.acct)) return;
      this.ctx.network.send('c', 'p:' + op.acct, { tx: st.id, phase: 'prepare', acct: op.acct, amount: op.amount, seq: 0, ack: 0 });
      this._armPrepareRetransmit(st, op);
    });
  }

  _armTimeout(st) {
    this.ctx.clock.schedule(this.ctx.T, 1, () => {
      if (this.crashed || st.decision) return;
      this.ctx.event(`prepare timeout tx=${st.id}`);
      this._decide(st, 'abort', 'PREPARE_TIMEOUT');
    });
  }

  _decide(st, decision, reason) {
    if (st.decision) return;
    st.decision = decision;
    st.reason = reason ?? null;
    this.wal.append({ tx: st.id, type: 'decision', data: { decision, ...(st.reason ? { reason: st.reason } : {}) } }, this.ctx.now());
    this.ctx.event(`decision ${decision} tx=${st.id}${st.reason ? ' ' + st.reason : ''}`);
    if (this.ctx.hook('c', st.id, 'afterCommitLog')) return;
    this._sendDecisions(st);
  }

  _sendDecisions(st) {
    for (const op of st.ops) {
      if (st.acked.has(op.acct)) continue;
      this.ctx.network.send('c', 'p:' + op.acct, { tx: st.id, phase: st.decision, acct: op.acct, amount: op.amount, seq: 1, ack: 0 });
      this._armDecisionRetransmit(st, op);
    }
  }

  _armDecisionRetransmit(st, op) {
    this.ctx.clock.schedule(this.ctx.R, 1, () => {
      if (this.crashed || st.done || st.acked.has(op.acct)) return;
      this.ctx.network.send('c', 'p:' + op.acct, { tx: st.id, phase: st.decision, acct: op.acct, amount: op.amount, seq: 1, ack: 0 });
      this._armDecisionRetransmit(st, op);
    });
  }

  receive(from, msg) {
    const st = this.txs.get(msg.tx);
    if (!st) {
      this.ctx.event(`ignored message for unknown tx=${msg.tx} from=${from}`);
      return;
    }
    if (msg.phase === 'prepare') {
      if (from !== 'p:' + msg.acct) {
        this.ctx.violation(`vote for acct ${msg.acct} came from ${from}`);
        return;
      }
      const key = `${from}|${msg.tx}|${msg.seq}`;
      if (this.seenVotes.has(key)) return;
      this.seenVotes.add(key);
      if (st.decision) return; // already decided (e.g. vote after commit)
      st.votes.set(msg.acct, { vote: msg.vote, reason: msg.reason ?? null });
      if (msg.vote === 'no') {
        this._decide(st, 'abort', msg.reason || 'VOTE_NO');
      } else if (st.ops.every((op) => st.votes.get(op.acct)?.vote === 'yes')) {
        this._decide(st, 'commit');
      }
    } else if (msg.phase === 'commit' || msg.phase === 'abort') {
      if (!st.decision || st.done) return;
      if (msg.ack === 1 && msg.accepted !== false) {
        st.acked.add(msg.acct);
        if (st.ops.every((op) => st.acked.has(op.acct))) {
          st.done = true;
          this.wal.append({ tx: st.id, type: 'done', data: {} }, this.ctx.now());
          this.ctx.event(`done tx=${st.id}`);
        }
      }
    } else {
      this.ctx.violation(`unknown phase ${msg.phase}`);
    }
  }

  // Recovery: decided-but-unfinished txs re-notify participants; begun but
  // undecided txs are aborted (no participant can hold a commit expectation).
  recover() {
    this.crashed = false;
    this.txs.clear();
    this.seenVotes.clear();
    for (const rec of this.wal.records) {
      if (rec.type === 'begin') this.txs.set(rec.tx, this._newState(rec.tx, rec.data.ops));
      else if (rec.type === 'decision') {
        const st = this.txs.get(rec.tx);
        st.decision = rec.data.decision;
        st.reason = rec.data.reason ?? null;
      } else if (rec.type === 'done') {
        this.txs.get(rec.tx).done = true;
      }
    }
    for (const st of this.txs.values()) {
      if (st.done) continue;
      this.ctx.event(`recovery tx=${st.id} decision=${st.decision || 'none'}`);
      if (st.decision) this._sendDecisions(st);
      else this._decide(st, 'abort', 'RECOVERY');
    }
  }
}

module.exports = Coordinator;
