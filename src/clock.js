'use strict';

// Deterministic virtual clock. Timers fire only when advance() moves time
// past their deadline, in (time, insertion-id) order.
class VirtualClock {
  constructor() {
    this.t = 0;
    this.timers = new Map();
    this.nextId = 1;
  }
  now() {
    return this.t;
  }
  set(fn, ms) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clear(id) {
    this.timers.delete(id);
  }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let bestId = null;
      let best = null;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && (best === null || tm.at < best.at || (tm.at === best.at && id < bestId))) {
          best = tm;
          bestId = id;
        }
      }
      if (best === null) break;
      this.timers.delete(bestId);
      this.t = best.at;
      best.fn();
    }
    this.t = end;
  }
}

module.exports = { VirtualClock };
