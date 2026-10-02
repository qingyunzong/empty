'use strict';

// Deterministic virtual clock: time only moves when advance() is called.
class VirtualClock {
  constructor() { this.t = 0; }
  now() { return this.t; }
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('advance requires ms >= 0');
    this.t += ms;
    return this.t;
  }
}

module.exports = { VirtualClock };
