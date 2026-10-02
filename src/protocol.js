'use strict';

const frame = require('./frame');

// Sending side: go-back-N style. Every DATA frame gets a monotonically
// increasing seq; unacked frames are retransmitted (in seq order) once the
// virtual clock has advanced rtoMs since the last ack progress.
class Sender {
  constructor(clock, { rtoMs = 1000 } = {}) {
    this.clock = clock;
    this.rtoMs = rtoMs;
    this.nextSeq = 0;
    this.unacked = new Map(); // seq -> record
    this.lastProgress = clock.now();
    this.stats = { sent: 0, retransmits: 0, ackRounds: 0 };
  }

  dataFrame(batchId, lineNo, payloadObj) {
    const rec = {
      seq: this.nextSeq++,
      batchId,
      lineNo,
      payload: Buffer.from(JSON.stringify(payloadObj), 'utf8'),
    };
    this.unacked.set(rec.seq, rec);
    this.stats.sent++;
    return rec;
  }

  encode(rec) {
    return frame.encode({
      type: frame.TYPE.DATA,
      batchId: rec.batchId,
      lineNo: rec.lineNo,
      seq: rec.seq,
      ack: 0,
      payload: rec.payload,
    });
  }

  onAck(ack) {
    let progressed = false;
    for (const seq of [...this.unacked.keys()]) {
      if (seq < ack) { this.unacked.delete(seq); progressed = true; }
    }
    if (progressed) {
      this.lastProgress = this.clock.now();
      this.stats.ackRounds++;
    }
  }

  retransmitDue() {
    return this.unacked.size > 0 && this.clock.now() - this.lastProgress >= this.rtoMs;
  }

  retransmit() {
    const recs = [...this.unacked.values()].sort((a, b) => a.seq - b.seq);
    this.stats.retransmits += recs.length;
    this.lastProgress = this.clock.now();
    return recs;
  }
}

// Receiving side: cumulative ack. In-order frames are delivered to the
// business layer immediately; out-of-order frames are buffered and drained
// once the gap closes; already-delivered seqs are deduplicated. The returned
// ack is always the next expected seq.
class Receiver {
  constructor() {
    this.expected = 0;
    this.buffer = new Map(); // seq -> frame (out-of-order cache)
    this.stats = { received: 0, duplicates: 0, outOfOrder: 0, delivered: 0 };
  }

  onData(f) {
    this.stats.received++;
    const delivered = [];
    if (f.seq < this.expected) {
      this.stats.duplicates++;
    } else if (f.seq > this.expected) {
      if (this.buffer.has(f.seq)) this.stats.duplicates++;
      else this.buffer.set(f.seq, f);
      this.stats.outOfOrder++;
    } else {
      delivered.push(f);
      this.expected++;
      while (this.buffer.has(this.expected)) {
        delivered.push(this.buffer.get(this.expected));
        this.buffer.delete(this.expected);
        this.expected++;
      }
    }
    this.stats.delivered += delivered.length;
    return { delivered, ack: this.expected };
  }
}

module.exports = { Sender, Receiver };
