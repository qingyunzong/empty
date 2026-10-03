'use strict';

// Pausable virtual clock with an integrated timer scheduler, injectable into
// the Gateway so tests can freeze time and control retransmit timeouts.
class VirtualClock {
  constructor() {
    this.t = 0;
    this.paused = false;
    this.timers = new Map();
    this.seq = 0;
  }
  now() { return this.t; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  advance(ms) {
    if (this.paused) return;
    const target = this.t + ms;
    for (;;) {
      let nextId = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.t = timer.at;
      timer.fn();
    }
    this.t = target;
  }
}

class RealClock {
  now() { return Date.now(); }
  pause() {}
  resume() {}
  setTimeout(fn, ms) { return setTimeout(fn, ms); }
  clearTimeout(id) { clearTimeout(id); }
  advance() {}
}

module.exports = { VirtualClock, RealClock };
