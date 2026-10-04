'use strict';
const Wal = require('./wal');

// Participant (branch) node. Owns one account. Durable state lives in the
// WAL; balances/frozen/incoming are volatile and rebuilt by replay.
//
// WAL records per tx:
//   vote    {acct, amount, vote, reason?}  - written before replying
//   commit  {acct, amount}                 - decision logged before applying
//   applied {acct, amount}                 - transfer applied to balances
//   abort   {acct, amount}                 - freeze released
// amount < 0 => debit leg (freezes funds), amount > 0 => credit leg
// (reserves headroom against creditLimit).
class Participant {
  constructor(ctx, acct, initial) {
    this.ctx = ctx;
    this.acct = acct;
    this.id = 'p:' + acct;
    this.wal = new Wal(ctx.walPath(this.id), this.id);
    this.txs = new Map();
    this.replies = new Map(); // dedupe key "from|tx|seq" -> cached reply fields
    this.sendSeq = new Map(); // tx -> next reply seq
    this.crashed = false;
    if (this.wal.records.length === 0) {
      this.initial = { balance: initial.balance, creditLimit: initial.creditLimit ?? null };
      this.wal.append({ tx: '-', type: 'init', data: { acct, ...this.initial } }, ctx.now());
      this._reset();
    } else {
      this.recover();
    }
  }

  _reset() {
    this.balance = this.initial.balance;
    this.creditLimit = this.initial.creditLimit;
    this.frozen = 0;
    this.incoming = 0;
  }

  recover() {
    this.crashed = false;
    this.txs.clear();
    this.replies.clear();
    this.sendSeq.clear();
    const init = this.wal.records.find((r) => r.type === 'init');
    this.initial = { balance: init.data.balance, creditLimit: init.data.creditLimit ?? null };
    this._reset();
    for (const rec of this.wal.records) this._applyRecord(rec);
    // Finish commits that were logged but not applied (crash between the two).
    for (const [txId, st] of this.txs) {
      if (st.state === 'committing') {
        this._applyTransfer(st);
        this.wal.append({ tx: txId, type: 'applied', data: { acct: this.acct, amount: st.amount } }, this.ctx.now());
        st.state = 'committed';
        this.ctx.event(`recovery applied logged commit ${this.id} tx=${txId}`);
      }
    }
  }

  _applyRecord(rec) {
    const d = rec.data || {};
    switch (rec.type) {
      case 'init':
        break;
      case 'vote':
        if (d.vote === 'yes') {
          this._freeze(d.amount);
          this.txs.set(rec.tx, { vote: 'yes', state: 'prepared', amount: d.amount });
        } else {
          this.txs.set(rec.tx, { vote: 'no', state: 'aborted', amount: d.amount, reason: d.reason });
        }
        break;
      case 'commit': {
        const st = this.txs.get(rec.tx);
        if (st && st.state === 'prepared') st.state = 'committing';
        break;
      }
      case 'applied': {
        const st = this.txs.get(rec.tx);
        if (st && st.state !== 'committed') {
          this._applyTransfer(st);
          st.state = 'committed';
        }
        break;
      }
      case 'abort': {
        const st = this.txs.get(rec.tx);
        if (st && st.state === 'prepared') {
          this._unfreeze(st.amount);
          st.state = 'aborted';
        }
        break;
      }
    }
  }

  _freeze(amount) {
    if (amount < 0) this.frozen -= amount;
    else this.incoming += amount;
  }
  _unfreeze(amount) {
    if (amount < 0) this.frozen += amount;
    else this.incoming -= amount;
  }
  _applyTransfer(st) {
    this.balance += st.amount;
    this._unfreeze(st.amount);
  }

  receive(from, msg) {
    if (msg.acct !== this.acct) {
      this.ctx.violation(`${this.id} received message for acct ${msg.acct}`);
      return;
    }
    const key = `${from}|${msg.tx}|${msg.seq}`;
    if (this.replies.has(key)) {
      this.ctx.event(`duplicate ${msg.phase} ${this.id} tx=${msg.tx} seq=${msg.seq} -> resend cached reply`);
      this.ctx.network.send(this.id, from, this.replies.get(key));
      return;
    }
    if (msg.phase === 'prepare') this._onPrepare(key, from, msg);
    else this._onDecision(key, from, msg, msg.phase);
  }

  _reply(key, from, msg, extra, cache) {
    const seq = this.sendSeq.get(msg.tx) ?? 0;
    this.sendSeq.set(msg.tx, seq + 1);
    const reply = { tx: msg.tx, phase: msg.phase, acct: this.acct, amount: msg.amount, seq, ack: msg.seq, ...extra };
    if (cache) this.replies.set(key, reply);
    this.ctx.network.send(this.id, from, reply);
  }

  _onPrepare(key, from, msg) {
    const existing = this.txs.get(msg.tx);
    if (existing) {
      // Duplicate prepare for a known tx: return the original vote, never re-freeze.
      this.ctx.event(`duplicate prepare ${this.id} tx=${msg.tx} -> original vote ${existing.vote} (${existing.state})`);
      this._reply(key, from, msg, {
        vote: existing.vote,
        state: existing.state,
        ...(existing.reason ? { reason: existing.reason } : {}),
      }, true);
      return;
    }
    const amount = msg.amount;
    let vote = 'yes';
    let reason;
    if (amount < 0 && this.balance - this.frozen + amount < 0) {
      vote = 'no';
      reason = 'INSUFFICIENT_FUNDS';
    } else if (amount > 0 && this.creditLimit != null && this.balance + this.incoming + amount > this.creditLimit) {
      vote = 'no';
      reason = 'CREDIT_LIMIT';
    }
    this.wal.append({ tx: msg.tx, type: 'vote', data: { acct: this.acct, amount, vote, ...(reason ? { reason } : {}) } }, this.ctx.now());
    if (this.ctx.hook(this.id, msg.tx, 'afterPrepareLog')) return;
    if (vote === 'yes') this._freeze(amount);
    this.txs.set(msg.tx, { vote, state: vote === 'yes' ? 'prepared' : 'aborted', amount, reason });
    this.ctx.event(`vote ${vote} ${this.id} tx=${msg.tx}${reason ? ' ' + reason : ''}`);
    this._reply(key, from, msg, { vote, state: this.txs.get(msg.tx).state, ...(reason ? { reason } : {}) }, true);
  }

  _onDecision(key, from, msg, phase) {
    const st = this.txs.get(msg.tx);
    if (phase === 'commit') {
      if (st && st.state === 'aborted') {
        this.ctx.violation(`commit after abort ${this.id} tx=${msg.tx}`);
        return;
      }
      if (!st) {
        // Prepare has not arrived (lost or reordered): refuse, coordinator retries.
        this._reply(key, from, msg, { accepted: false, state: 'unknown' }, false);
        return;
      }
      if (st.state !== 'committed') {
        this.wal.append({ tx: msg.tx, type: 'commit', data: { acct: this.acct, amount: st.amount } }, this.ctx.now());
        st.state = 'committing';
        if (this.ctx.hook(this.id, msg.tx, 'afterCommitLog')) return;
        this._applyTransfer(st);
        this.wal.append({ tx: msg.tx, type: 'applied', data: { acct: this.acct, amount: st.amount } }, this.ctx.now());
        st.state = 'committed';
        if (this.ctx.hook(this.id, msg.tx, 'afterApply')) return;
      }
      this._reply(key, from, msg, { accepted: true, state: 'committed' }, true);
      return;
    }
    // abort
    if (st && st.state === 'committed') {
      this.ctx.violation(`abort after commit ${this.id} tx=${msg.tx}`);
      return;
    }
    if (st && st.state === 'prepared') {
      this.wal.append({ tx: msg.tx, type: 'abort', data: { acct: this.acct, amount: st.amount } }, this.ctx.now());
      this._unfreeze(st.amount);
      st.state = 'aborted';
      this.ctx.event(`aborted ${this.id} tx=${msg.tx}`);
    }
    // Unknown tx: presumptive abort, nothing was frozen; still ack.
    this._reply(key, from, msg, { accepted: true, state: 'aborted' }, true);
  }
}

module.exports = Participant;
