'use strict';

const { Reassembler } = require('./frame');
const { appendCertificate } = require('./certificate');

class Coordinator {
  constructor(id, disk, engine, opts) {
    this.id = id;
    this.disk = disk;
    this.engine = engine;
    this.reassembler = new Reassembler();
    this.crashed = false;
    this.seqCounter = 0;
    this.prepareTimeout = opts.prepareTimeout;
    this.retryInterval = opts.retryInterval;
    this.routing = opts.routing;
    this.txs = new Map();
    this.recover();
  }

  nextSeq() {
    return this.seqCounter++;
  }

  log(entry) {
    this.disk.wal.push(entry);
  }

  recover() {
    for (const entry of this.disk.wal) this.replay(entry);
    for (const tx of this.txs.values()) {
      if (tx.decision) {
        this.ensureCertificate(tx);
        this.broadcastDecision(tx);
      } else {
        this.sendPrepares(tx, true);
        const remaining = this.prepareTimeout - (this.engine.now - tx.beginAt);
        if (remaining <= 0) this.decide(tx, 'abort', 'PREPARE_TIMEOUT');
        else this.schedulePrepareTimeout(tx, remaining);
      }
    }
  }

  replay(entry) {
    switch (entry.op) {
      case 'begin':
        this.txs.set(entry.tx, {
          tx: entry.tx,
          legs: entry.legs,
          beginAt: entry.at,
          votes: new Map(),
          acks: new Set(),
          decision: null,
          reason: '',
        });
        break;
      case 'vote': {
        const tx = this.txs.get(entry.tx);
        if (tx) tx.votes.set(entry.acct, { ack: entry.ack, reason: entry.reason });
        break;
      }
      case 'decision': {
        const tx = this.txs.get(entry.tx);
        if (tx) {
          tx.decision = entry.decision;
          tx.reason = entry.reason;
        }
        break;
      }
      case 'ack': {
        const tx = this.txs.get(entry.tx);
        if (tx) tx.acks.add(entry.acct);
        break;
      }
      default:
        break;
    }
  }

  begin(txDef) {
    if (this.crashed || this.txs.has(txDef.tx)) return;
    const entry = { op: 'begin', tx: txDef.tx, legs: txDef.legs, at: this.engine.now };
    this.log(entry);
    this.replay(entry);
    const tx = this.txs.get(txDef.tx);
    this.sendPrepares(tx, false);
    this.schedulePrepareTimeout(tx, this.prepareTimeout);
  }

  sendPrepares(tx, onlyMissing) {
    for (const leg of tx.legs) {
      if (onlyMissing && tx.votes.has(leg.acct)) continue;
      this.engine.send(this.id, this.routing[leg.acct], {
        tx: tx.tx,
        phase: 'prepare',
        acct: leg.acct,
        amount: leg.amount,
      });
    }
    this.engine.schedule(this.retryInterval, () => {
      if (this.crashed || tx.decision) return;
      this.sendPrepares(tx, true);
    });
  }

  schedulePrepareTimeout(tx, delay) {
    this.engine.schedule(delay, () => {
      if (this.crashed || tx.decision) return;
      this.decide(tx, 'abort', 'PREPARE_TIMEOUT');
    });
  }

  onMessage(msg) {
    if (this.crashed) return;
    if (msg.phase === 'vote') this.onVote(msg);
    else if (msg.phase === 'ack') this.onAck(msg);
    else this.engine.error('PROTOCOL', { node: this.id, tx: msg.tx, detail: `unexpected phase ${msg.phase}` });
  }

  onVote(msg) {
    const tx = this.txs.get(msg.tx);
    if (!tx) {
      this.engine.error('UNKNOWN_TX', { node: this.id, tx: msg.tx, detail: 'vote for unknown tx' });
      return;
    }
    if (tx.decision || tx.votes.has(msg.acct)) return;
    const entry = { op: 'vote', tx: msg.tx, acct: msg.acct, ack: msg.ack, reason: msg.reason || '' };
    this.log(entry);
    this.replay(entry);
    if (msg.ack !== 'yes') {
      this.decide(tx, 'abort', msg.reason || 'VOTE_NO');
      return;
    }
    if (tx.legs.every((l) => tx.votes.has(l.acct) && tx.votes.get(l.acct).ack === 'yes')) {
      this.decide(tx, 'commit', '');
    }
  }

  decide(tx, decision, reason) {
    if (tx.decision) return;
    const entry = { op: 'decision', tx: tx.tx, decision, reason: reason || '' };
    this.log(entry);
    this.replay(entry);
    this.ensureCertificate(tx);
    if (this.engine.maybeCrash(this.id, tx.tx, 'after-decision-log')) return;
    this.broadcastDecision(tx);
  }

  ensureCertificate(tx) {
    if (this.disk.certChain.some((c) => c.tx === tx.tx)) return;
    const votes = {};
    for (const [acct, v] of tx.votes) votes[acct] = v.ack + (v.reason ? ':' + v.reason : '');
    appendCertificate(this.disk.certChain, {
      tx: tx.tx,
      decision: tx.decision,
      reason: tx.reason || '',
      votes,
      at: this.engine.now,
    });
  }

  broadcastDecision(tx) {
    for (const leg of tx.legs) {
      if (tx.acks.has(leg.acct)) continue;
      this.engine.send(this.id, this.routing[leg.acct], {
        tx: tx.tx,
        phase: tx.decision,
        acct: leg.acct,
        amount: leg.amount,
      });
    }
    this.engine.schedule(this.retryInterval, () => {
      if (this.crashed) return;
      if (tx.legs.every((l) => tx.acks.has(l.acct))) return;
      this.broadcastDecision(tx);
    });
  }

  onAck(msg) {
    const tx = this.txs.get(msg.tx);
    if (!tx) {
      this.engine.error('UNKNOWN_TX', { node: this.id, tx: msg.tx, detail: 'ack for unknown tx' });
      return;
    }
    if (msg.ack === 'nack') {
      this.engine.error(msg.reason === 'UNKNOWN_TX' ? 'UNKNOWN_TX' : 'PROTOCOL', {
        node: this.id,
        tx: msg.tx,
        detail: `participant nack ${msg.reason}`,
      });
      return;
    }
    if (!tx.decision) {
      this.engine.error('PROTOCOL', { node: this.id, tx: msg.tx, detail: 'ack before decision' });
      return;
    }
    if (tx.acks.has(msg.acct)) return;
    const entry = { op: 'ack', tx: msg.tx, acct: msg.acct };
    this.log(entry);
    this.replay(entry);
  }
}

module.exports = { Coordinator };
