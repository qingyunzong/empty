'use strict';

// Protocol-layer retransmission buffer. Frames that are not acknowledged
// within timeoutMs are returned again by due(); the receiver's dedup (by
// event id, see Engine.apply) makes delivery exactly-once.
class Retransmitter {
  #pending = new Map();

  constructor({ timeoutMs = 1000 } = {}) {
    this.timeoutMs = timeoutMs;
  }

  send(key, bytes, now = 0) {
    this.#pending.set(key, { bytes, lastSent: now });
    return bytes;
  }

  ack(key) {
    return this.#pending.delete(key);
  }

  due(now) {
    const out = [];
    for (const entry of this.#pending.values()) {
      if (now - entry.lastSent >= this.timeoutMs) {
        entry.lastSent = now;
        out.push(entry.bytes);
      }
    }
    return out;
  }

  get pending() {
    return this.#pending.size;
  }
}

module.exports = { Retransmitter };
