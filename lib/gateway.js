'use strict';

const { VirtualClock } = require('./clock');
const { Ledger, ProtocolError } = require('./ledger');

// Sequencing gateway between the PLC byte stream and the offline ledger.
//  - in-order delivery by seq (reorder buffer for out-of-order frames)
//  - dedup cache: re-delivered seqs are dropped, never double-posted
//  - gap detection triggers RETRANSMIT_REQUEST; the virtual clock drives
//    timeout-based retries up to maxRetries, then SEQ_GAP_TIMEOUT
class Gateway {
  constructor({ timeout = 2, maxRetries = 3, clock } = {}) {
    this.clock = clock || new VirtualClock();
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.expected = 0;
    this.deliveredSeqs = new Set();
    this.pending = new Map(); // seq -> frame (out-of-order buffer)
    this.ledger = new Ledger();
    this.error = null;
    this.gap = null; // { from, to, attempt, lastRequestTick }
    this.stats = { frames: 0, duplicates: 0, reordered: 0, retransmitRequests: 0, events: 0 };
    this.digest = 0x811c9dc5;
  }

  ingest(frame) {
    if (this.error) return [];
    this.clock.tick(1);
    this.stats.frames++;
    const events = [];
    const seq = frame.seq;
    if (seq < this.expected || this.deliveredSeqs.has(seq) || this.pending.has(seq)) {
      this.stats.duplicates++;
      events.push({ event: 'DUPLICATE_DROPPED', seq });
    } else if (seq === this.expected) {
      this._deliver(frame, events);
      this._drain(events);
    } else {
      this.pending.set(seq, frame);
      this.stats.reordered++;
      this._openOrExtendGap(seq, events);
    }
    if (!this.error) this._runTimers(events);
    return events;
  }

  finish() {
    const events = [];
    while (this.gap && !this.error) {
      this.clock.tick(1);
      this._runTimers(events);
    }
    events.push(this.certificate());
    return events;
  }

  certificate() {
    return {
      certificate: {
        ok: this.error === null,
        frames: this.stats.frames,
        delivered: this.deliveredSeqs.size,
        duplicates: this.stats.duplicates,
        reordered: this.stats.reordered,
        retransmitRequests: this.stats.retransmitRequests,
        events: this.stats.events,
        digest: this.digest.toString(16).padStart(8, '0'),
      },
    };
  }

  _deliver(frame, events) {
    let ev;
    try {
      ev = this.ledger.apply(frame);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.error = { code: err.code, seq: frame.seq, message: err.message };
        return;
      }
      throw err;
    }
    this.deliveredSeqs.add(frame.seq);
    this.expected = frame.seq + 1;
    this.stats.events++;
    this._mixDigest(ev);
    events.push(ev);
  }

  _drain(events) {
    while (this.pending.has(this.expected) && !this.error) {
      const frame = this.pending.get(this.expected);
      this.pending.delete(this.expected);
      this._deliver(frame, events);
    }
    if (this.pending.size === 0) this.gap = null;
  }

  _openOrExtendGap(seq, events) {
    if (!this.gap) {
      this.gap = { from: this.expected, to: seq - 1, attempt: 1, lastRequestTick: this.clock.now };
      this.stats.retransmitRequests++;
      events.push(this._requestEvent());
    } else {
      this.gap.to = Math.max(this.gap.to, seq - 1);
    }
  }

  _runTimers(events) {
    if (!this.gap) return;
    if (this.clock.now - this.gap.lastRequestTick < this.timeout) return;
    const attempt = this.gap.attempt + 1;
    if (attempt > this.maxRetries) {
      this.error = { code: 'SEQ_GAP_TIMEOUT', from: this.gap.from, to: this.gap.to };
      return;
    }
    this.gap.attempt = attempt;
    this.gap.lastRequestTick = this.clock.now;
    this.stats.retransmitRequests++;
    events.push(this._requestEvent());
  }

  _requestEvent() {
    return {
      event: 'RETRANSMIT_REQUEST',
      from: this.gap.from,
      to: this.gap.to,
      attempt: this.gap.attempt,
      tick: this.clock.now,
    };
  }

  _mixDigest(obj) {
    const s = JSON.stringify(obj);
    let h = this.digest;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this.digest = h;
  }
}

module.exports = { Gateway };
