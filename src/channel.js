'use strict';

// Lossy channel driven by a seeded PRNG: transmit() returns true when the
// packet is delivered, false when it is lost.
class LossyChannel {
  constructor(rand, lossRate = 0) {
    this.rand = rand;
    this.lossRate = lossRate;
    this.stats = { delivered: 0, dropped: 0 };
  }

  transmit() {
    if (this.rand() < this.lossRate) {
      this.stats.dropped++;
      return false;
    }
    this.stats.delivered++;
    return true;
  }
}

// Deterministic channel for tests: `drops` is a Set of 0-based transmission
// indices to drop, or a predicate (message, index) => boolean (true = drop).
class ScriptedChannel {
  constructor(drops = new Set()) {
    this.drops = drops;
    this.index = 0;
    this.stats = { delivered: 0, dropped: 0 };
  }

  transmit(message) {
    const i = this.index++;
    const drop =
      typeof this.drops === 'function' ? this.drops(message, i) : this.drops.has(i);
    if (drop) {
      this.stats.dropped++;
      return false;
    }
    this.stats.delivered++;
    return true;
  }
}

module.exports = { LossyChannel, ScriptedChannel };
