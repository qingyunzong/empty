'use strict';

const { Reassembler } = require('./frame');

class Participant {
  constructor(id, disk, engine, opts = {}) {
    this.id = id;
    this.disk = disk;
    this.engine = engine;
    this.reassembler = new Reassembler();
    this.crashed = false;
    this.seqCounter = 0;
    this.accounts = new Map();
    this.txs = new Map();
    this.readOnly = opts.readOnly || false;
    this.recover();
  }

  nextSeq() {
    return this.seqCounter++;
  }

  log(entry) {
    if (!this.readOnly) this.disk.wal.push(entry);
  }

  recover() {
    for (const [acct, a] of Object.entries(this.disk.genesis)) {
      this.accounts.set(acct, { balance: a.balance, creditLimit: a.creditLimit, frozen: 0 });
    }
    for (const entry of this.disk.wal) this.replay(entry);
    if (!this.readOnly) {
      for (const [tx, rec] of this.txs) {
        if (rec.state === 'committed') this.applyTx(tx, rec);
      }
    }
  }

  replay(entry) {
    switch (entry.op) {
      case 'prepare': {
        if (entry.vote === 'yes') {
          this.txs.set(entry.tx, { acct: entry.acct, amount: entry.amount, vote: 'yes', reason: '', state: 'prepared' });
          if (entry.amount < 0) this.accounts.get(entry.acct).frozen += -entry.amount;
        } else {
          this.txs.set(entry.tx, { acct: entry.acct, amount: entry.amount, vote: 'no', reason: entry.reason, state: 'voted-no' });
        }
        break;
      }
      case 'commit': {
        const rec = this.txs.get(entry.tx);
        if (rec && rec.state === 'prepared') rec.state = 'committed';
        break;
      }
      case 'apply': {
        const rec = this.txs.get(entry.tx);
        if (rec && rec.state === 'committed') this.applyTx(entry.tx, rec, false);
        break;
      }
      case 'abort': {
        const rec = this.txs.get(entry.tx);
        if (rec && rec.state === 'prepared') {
          if (rec.amount < 0) this.accounts.get(rec.acct).frozen -= -rec.amount;
          rec.state = 'aborted';
        } else if (rec && rec.state === 'voted-no') {
          rec.state = 'aborted';
        }
        break;
      }
      default:
        break;
    }
  }

  applyTx(tx, rec, log = true) {
    const acct = this.accounts.get(rec.acct);
    if (rec.amount < 0) acct.frozen -= -rec.amount;
    acct.balance += rec.amount;
    rec.state = 'applied';
    if (log) this.log({ op: 'apply', tx });
  }

  coordId() {
    return (this.engine && this.engine.coordId) || 'COORD';
  }

  reply(msg) {
    this.engine.send(this.id, this.coordId(), msg);
  }

  onMessage(msg) {
    if (this.crashed) return;
    if (msg.phase === 'prepare') this.onPrepare(msg);
    else if (msg.phase === 'commit') this.onCommit(msg);
    else if (msg.phase === 'abort') this.onAbort(msg);
    else this.engine.error('PROTOCOL', { node: this.id, tx: msg.tx, detail: `unexpected phase ${msg.phase}` });
  }

  onPrepare(msg) {
    const existing = this.txs.get(msg.tx);
    if (existing) {
      this.reply({ tx: msg.tx, phase: 'vote', acct: existing.acct, amount: existing.amount, ack: existing.vote, reason: existing.reason || '' });
      return;
    }
    const acct = this.accounts.get(msg.acct);
    if (!acct) {
      this.engine.error('PROTOCOL', { node: this.id, tx: msg.tx, detail: `unknown account ${msg.acct}` });
      return;
    }
    let vote = 'yes';
    let reason = '';
    if (msg.amount < 0 && acct.balance - acct.frozen < -msg.amount) {
      vote = 'no';
      reason = 'INSUFFICIENT_FUNDS';
    } else if (msg.amount > 0 && acct.balance + msg.amount > acct.creditLimit) {
      vote = 'no';
      reason = 'CREDIT_LIMIT';
    } else if (msg.amount === 0) {
      vote = 'no';
      reason = 'ZERO_AMOUNT';
    }
    const entry = { op: 'prepare', tx: msg.tx, acct: msg.acct, amount: msg.amount, vote, reason };
    this.log(entry);
    this.replay(entry);
    if (this.engine.maybeCrash(this.id, msg.tx, 'after-prepare-log')) return;
    this.reply({ tx: msg.tx, phase: 'vote', acct: msg.acct, amount: msg.amount, ack: vote, reason });
  }

  onCommit(msg) {
    const rec = this.txs.get(msg.tx);
    if (!rec) {
      this.engine.error('UNKNOWN_TX', { node: this.id, tx: msg.tx, detail: 'commit for unknown tx' });
      this.reply({ tx: msg.tx, phase: 'ack', acct: msg.acct, amount: msg.amount, ack: 'nack', reason: 'UNKNOWN_TX' });
      return;
    }
    if (rec.state === 'applied') {
      this.reply({ tx: msg.tx, phase: 'ack', acct: rec.acct, amount: rec.amount, ack: 'ok', reason: '' });
      return;
    }
    if (rec.state === 'aborted' || rec.state === 'voted-no') {
      this.engine.error('PROTOCOL', { node: this.id, tx: msg.tx, detail: `commit in state ${rec.state}` });
      this.reply({ tx: msg.tx, phase: 'ack', acct: rec.acct, amount: rec.amount, ack: 'nack', reason: 'ILLEGAL_STATE' });
      return;
    }
    if (rec.state === 'prepared') {
      const entry = { op: 'commit', tx: msg.tx };
      this.log(entry);
      this.replay(entry);
      if (this.engine.maybeCrash(this.id, msg.tx, 'after-commit-log')) return;
      this.applyTx(msg.tx, rec);
      if (this.engine.maybeCrash(this.id, msg.tx, 'after-apply-before-ack')) return;
    } else if (rec.state === 'committed') {
      this.applyTx(msg.tx, rec);
    }
    this.reply({ tx: msg.tx, phase: 'ack', acct: rec.acct, amount: rec.amount, ack: 'ok', reason: '' });
  }

  onAbort(msg) {
    const rec = this.txs.get(msg.tx);
    if (!rec) {
      this.engine.error('UNKNOWN_TX', { node: this.id, tx: msg.tx, detail: 'abort for unknown tx' });
      this.reply({ tx: msg.tx, phase: 'ack', acct: msg.acct, amount: msg.amount, ack: 'nack', reason: 'UNKNOWN_TX' });
      return;
    }
    if (rec.state === 'committed' || rec.state === 'applied') {
      this.engine.error('PROTOCOL', { node: this.id, tx: msg.tx, detail: `abort in state ${rec.state}: never debit-and-unfreeze` });
      this.reply({ tx: msg.tx, phase: 'ack', acct: rec.acct, amount: rec.amount, ack: 'nack', reason: 'ILLEGAL_STATE' });
      return;
    }
    if (rec.state !== 'aborted') {
      const entry = { op: 'abort', tx: msg.tx };
      this.log(entry);
      this.replay(entry);
    }
    this.reply({ tx: msg.tx, phase: 'ack', acct: rec.acct, amount: rec.amount, ack: 'ok', reason: '' });
  }

  pending() {
    const out = [];
    for (const [tx, rec] of this.txs) {
      if (rec.state === 'prepared') {
        out.push({ participant: this.id, tx, acct: rec.acct, amount: rec.amount });
      }
    }
    return out;
  }
}

module.exports = { Participant };
