'use strict';
const { Wal } = require('./wal');
const {
  computeRemaining,
  buildDomains,
  findMatching,
  explainConflict,
} = require('./solver');

// Settlement engine. State (pairs, cancellations, frozen amounts) is rebuilt
// purely by replaying the WAL, so restarts never freeze the same funds twice.
//
// Crash point: "match log written, unfreeze log not written" — a cancel was
// requested for a matched instruction but the unfreeze record is missing.
// recover() completes the unfreeze and then rolls back the pair.
class Engine {
  constructor(walPath) {
    this.wal = new Wal(walPath);
    this.pairs = new Map(); // pairId -> active pair
    this.cancelled = new Set();
    this.frozen = {}; // accountId -> { cash, positions: { security: qty } }
    this.pairSeq = 0;
    this.replay();
  }

  replay() {
    for (const record of this.wal.records) {
      switch (record.op) {
        case 'match': {
          const pair = {
            pairId: record.pairId,
            buy: record.buy,
            sell: record.sell,
            security: record.security,
            price: record.price,
            quantity: record.quantity,
            buyAccount: record.buyAccount,
            sellAccount: record.sellAccount,
            amount: record.amount,
            unfrozen: false,
          };
          this.pairs.set(pair.pairId, pair);
          this.freeze(pair);
          const match = /^P(\d+)$/.exec(record.pairId);
          if (match) this.pairSeq = Math.max(this.pairSeq, Number(match[1]));
          break;
        }
        case 'cancel':
          this.cancelled.add(record.instruction);
          break;
        case 'unfreeze': {
          const pair = this.pairs.get(record.pairId);
          if (pair && !pair.unfrozen) {
            this.release(pair);
            pair.unfrozen = true;
          }
          break;
        }
        case 'unpair':
          this.pairs.delete(record.pairId);
          break;
        default:
          throw new Error(`unknown WAL op: ${record.op}`);
      }
    }
  }

  freeze(pair) {
    const cashEntry = (this.frozen[pair.buyAccount] ||= { cash: 0, positions: {} });
    cashEntry.cash += pair.amount;
    const secEntry = (this.frozen[pair.sellAccount] ||= { cash: 0, positions: {} });
    secEntry.positions[pair.security] = (secEntry.positions[pair.security] || 0) + pair.quantity;
  }

  release(pair) {
    const cashEntry = this.frozen[pair.buyAccount];
    if (cashEntry) {
      cashEntry.cash -= pair.amount;
      this.prune(pair.buyAccount);
    }
    const secEntry = this.frozen[pair.sellAccount];
    if (secEntry) {
      secEntry.positions[pair.security] -= pair.quantity;
      if (secEntry.positions[pair.security] === 0) delete secEntry.positions[pair.security];
      this.prune(pair.sellAccount);
    }
  }

  prune(accountId) {
    const entry = this.frozen[accountId];
    if (entry && entry.cash === 0 && Object.keys(entry.positions).length === 0) {
      delete this.frozen[accountId];
    }
  }

  unfreezePair(pairId) {
    const pair = this.pairs.get(pairId);
    if (!pair || pair.unfrozen) return;
    this.release(pair);
    pair.unfrozen = true;
    this.wal.append({ op: 'unfreeze', pairId });
  }

  // Recovery after a crash: any active pair whose cancel was logged but whose
  // unfreeze was not must be completed (unfreeze first, then roll back the pair).
  recover() {
    for (const pair of [...this.pairs.values()]) {
      if (this.cancelled.has(pair.buy) || this.cancelled.has(pair.sell)) {
        this.unfreezePair(pair.pairId);
        this.wal.append({ op: 'unpair', pairId: pair.pairId });
        this.pairs.delete(pair.pairId);
      }
    }
  }

  // Cancellation: unfreeze first, then break the pair.
  cancel(instructionId) {
    if (this.cancelled.has(instructionId)) return;
    this.wal.append({ op: 'cancel', instruction: instructionId });
    this.cancelled.add(instructionId);
    for (const pair of [...this.pairs.values()]) {
      if (pair.buy === instructionId || pair.sell === instructionId) {
        this.unfreezePair(pair.pairId);
        this.wal.append({ op: 'unpair', pairId: pair.pairId });
        this.pairs.delete(pair.pairId);
      }
    }
  }

  deliver(input) {
    const accounts = input.accounts || [];
    for (const id of input.cancellations || []) this.cancel(id);

    // Incremental: pairs already in the WAL stay fixed; only unmatched,
    // non-cancelled instructions participate in a new matching round.
    const matchedIds = new Set();
    for (const pair of this.pairs.values()) {
      matchedIds.add(pair.buy);
      matchedIds.add(pair.sell);
    }
    const active = (input.instructions || []).filter(
      (i) => !this.cancelled.has(i.id) && !matchedIds.has(i.id)
    );

    const remaining = computeRemaining(accounts, this.frozen);
    const domains = buildDomains(active, accounts, remaining);
    const pairs = findMatching({
      instructions: active,
      remaining,
      permissions: input.permissions,
      mustMatch: new Set(active.map((i) => i.id)),
      domains,
    });

    let status = 'SAT';
    let conflict = null;
    if (pairs === null) {
      status = 'UNSAT';
      conflict = explainConflict({
        instructions: active,
        accounts,
        remaining,
        permissions: input.permissions,
        domains,
      });
    } else {
      for (const pair of pairs) {
        const pairId = `P${++this.pairSeq}`;
        const full = { pairId, ...pair, unfrozen: false };
        this.freeze(full);
        this.pairs.set(pairId, full);
        this.wal.append({ op: 'match', pairId, ...pair });
      }
    }

    const matchedAfter = new Set();
    for (const pair of this.pairs.values()) {
      matchedAfter.add(pair.buy);
      matchedAfter.add(pair.sell);
    }
    const unmatched = (input.instructions || [])
      .filter((i) => !this.cancelled.has(i.id) && !matchedAfter.has(i.id))
      .map((i) => i.id);

    return {
      status,
      pairs: [...this.pairs.values()].map(({ unfrozen, ...pair }) => pair),
      frozen: this.frozen,
      remaining: computeRemaining(accounts, this.frozen),
      domains: Object.fromEntries(domains),
      unmatched,
      cancelled: [...this.cancelled],
      conflict,
    };
  }
}

module.exports = { Engine };
