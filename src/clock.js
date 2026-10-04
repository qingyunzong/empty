'use strict';

// Deterministic virtual clock with a (time, priority, seq) ordered event heap.
// priority 0 = message delivery, 1 = timer, so deliveries win ties at the
// same virtual instant (a vote arriving exactly at the deadline counts).
class Clock {
  constructor() {
    this.now = 0;
    this.seq = 0;
    this.heap = [];
    this.byId = new Map();
  }
  schedule(delay, priority, fn) {
    const id = ++this.seq;
    const ev = { time: this.now + delay, pri: priority, id, fn, cancelled: false };
    this.byId.set(id, ev);
    this._push(ev);
    return id;
  }
  cancel(id) {
    const ev = this.byId.get(id);
    if (ev) ev.cancelled = true;
  }
  _less(a, b) {
    return a.time - b.time || a.pri - b.pri || a.id - b.id;
  }
  _push(ev) {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._less(h[i], h[p]) < 0) {
        [h[i], h[p]] = [h[p], h[i]];
        i = p;
      } else break;
    }
  }
  _pop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this._less(h[l], h[m]) < 0) m = l;
        if (r < h.length && this._less(h[r], h[m]) < 0) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
  // Returns true if the queue drained, false if cut off at maxTime.
  run(maxTime) {
    while (this.heap.length) {
      const ev = this._pop();
      if (ev.cancelled) continue;
      if (ev.time > maxTime) {
        this.now = maxTime;
        return false;
      }
      this.now = ev.time;
      ev.fn();
    }
    return true;
  }
}

module.exports = Clock;
