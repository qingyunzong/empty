'use strict';

const { PositionalIndex } = require('./index');
const { Ledger } = require('./ledger');

// Ties the trade ledger and the description index together with
// a shared persistent data directory (single-machine, offline).
class SettlementSystem {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.ledger = new Ledger(dir, options);
    this.index = new PositionalIndex(dir, options);
  }

  addTrade(trade) {
    // Ledger validation runs first; on error nothing is indexed.
    const result = this.ledger.addTrade(trade);
    this.index.addDoc(trade.id, trade.desc);
    return result;
  }

  revokeTrade(id) {
    return this.ledger.revokeTrade(id);
  }

  deleteTrade(id) {
    // Ledger validation runs first; on error no tombstone is written.
    const certificate = this.ledger.deleteTrade(id);
    const tombstone = this.index.deleteDoc(id);
    return { certificate, tombstone };
  }

  phrase(query) {
    return this.index.phrase(query);
  }

  near(a, b, k) {
    return this.index.near(a, b, k);
  }

  getNet(a, b) {
    return this.ledger.getNet(a, b);
  }

  compact() {
    return this.index.compact();
  }

  hash() {
    return { ledger: this.ledger.hash(), index: this.index.hash() };
  }
}

module.exports = { SettlementSystem };
