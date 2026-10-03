'use strict';

// Deterministic virtual clock for offline replay: time only advances on tick().
class VirtualClock {
  constructor() {
    this.now = 0;
  }

  tick(step = 1) {
    this.now += step;
    return this.now;
  }
}

module.exports = { VirtualClock };
