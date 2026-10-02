'use strict';

const { VirtualClock } = require('./clock');
const { Ledger, parseAmount, fmt } = require('./ledger');
const { Sender, Receiver } = require('./protocol');
const { encodeFrame, parseFrames, TYPE_DATA, FLAG_EOB, FLAG_REVERSAL } = require('./frame');
const { canon } = require('./canon');
const { BusinessError } = require('./errors');

// Reads frame header fields straight off the wire bytes (length prefix at 0).
function peek(buf) {
  return {
    batchId: buf.readUInt32BE(6),
    lineNo: buf.readUInt16BE(10),
    seq: buf.readUInt16BE(12),
    flags: buf.readUInt8(16),
  };
}

const faultSet = (list) => new Set((list ?? []).map(String));
const hit = (set, batchId, seq) => set.has(`${batchId}:${seq}`) || set.has(String(seq));

// Engine wires sender, lossy link, receiver and ledger together. The link
// fault model (drop / dup / corrupt / split / reorder) is applied in pump().
class Engine {
  constructor(opts = {}) {
    this.clock = new VirtualClock();
    this.ledger = new Ledger(this.clock, opts);
    this.sender = new Sender(this.clock, { rtoMs: opts.rtoMs ?? 1000 });
    this.receiver = new Receiver();
    this.ledger.onBatchAborted = (id) => this.sender.dropBatch(id);
  }

  configure(opts = {}) {
    if (opts.limit != null) this.ledger.limit = parseAmount(opts.limit);
    if (opts.perLineLimit != null) this.ledger.perLineLimit = parseAmount(opts.perLineLimit);
    if (opts.currencies != null) this.ledger.currencies = opts.currencies;
    if (opts.rtoMs != null) this.sender.rtoMs = opts.rtoMs;
  }

  submit(op) {
    const batchId = op.batch;
    const lines = op.lines;
    this.ledger.submitBatch({ batchId, lines, timeoutMs: op.timeoutMs ?? null });
    const frames = lines.map((l, i) => {
      const flags = (i === lines.length - 1 ? FLAG_EOB : 0) | (l.reversalOf ? FLAG_REVERSAL : 0);
      const payload = Buffer.from(
        canon({
          amount: String(l.amount),
          currency: String(l.currency),
          direction: l.direction,
          lineNo: l.lineNo,
          reversalOf: l.reversalOf ?? null,
        }),
        'utf8',
      );
      return {
        seq: i + 1,
        buf: encodeFrame({ type: TYPE_DATA, batchId, lineNo: l.lineNo, seq: i + 1, ack: 0, flags, payload }),
      };
    });
    this.sender.sendBatch(batchId, frames);
  }

  reverse(op) {
    const of = op.of ?? {};
    const target = this.ledger.findLine(of.batch, of.lineNo);
    if (!target) throw new BusinessError('reversal target not found');
    const direction = target.direction === 'pay' ? 'receive' : 'pay';
    this.submit({
      batch: op.batch,
      timeoutMs: op.timeoutMs ?? null,
      lines: [{
        lineNo: op.lineNo ?? 1,
        amount: fmt(target.amount),
        currency: target.currency,
        direction,
        reversalOf: { batch: of.batch, lineNo: of.lineNo },
      }],
    });
  }

  // Moves everything in the sender outbox across the lossy link, then flushes
  // receiver outputs into the ledger and ACKs back into the sender.
  // faults: { order:[seq|"b:s"], drop:[...], dup:[...], corrupt:[...],
  //           split:[[seq, byteOffset]], dropAck:bool }
  // Returns the list of frames the receiver accepted, in arrival order.
  pump(faults = {}) {
    const drop = faultSet(faults.drop);
    const dup = faultSet(faults.dup);
    const corrupt = faultSet(faults.corrupt);
    const splitSpec = new Map();
    for (const entry of faults.split ?? []) splitSpec.set(String(entry[0]), entry[1]);
    const order = faults.order ? new Map(faults.order.map((k, i) => [String(k), i])) : null;

    const frames = this.sender.drain().map((buf) => ({ buf, h: peek(buf) }));
    if (order) {
      const pos = (h) => {
        const k = `${h.batchId}:${h.seq}`;
        if (order.has(k)) return order.get(k);
        if (order.has(String(h.seq))) return order.get(String(h.seq));
        return 1e9;
      };
      frames.sort((a, b) => pos(a.h) - pos(b.h) || a.h.batchId - b.h.batchId || a.h.seq - b.h.seq);
    }

    const delivered = [];
    const emit = (buf, h, record) => {
      const at = splitSpec.has(`${h.batchId}:${h.seq}`)
        ? splitSpec.get(`${h.batchId}:${h.seq}`)
        : splitSpec.get(String(h.seq));
      if (at != null) {
        this.receiver.feed(buf.subarray(0, at));
        this.receiver.feed(buf.subarray(at));
      } else {
        this.receiver.feed(buf);
      }
      if (record) delivered.push({ batch: h.batchId, seq: h.seq, eob: (h.flags & FLAG_EOB) !== 0 });
    };

    for (const f of frames) {
      if (hit(drop, f.h.batchId, f.h.seq)) continue;
      if (hit(corrupt, f.h.batchId, f.h.seq)) {
        const bad = Buffer.from(f.buf);
        bad[bad.length - 3] ^= 0xff; // flip a bit inside the stored CRC
        emit(bad, f.h, false);
      } else {
        emit(f.buf, f.h, true);
      }
      if (hit(dup, f.h.batchId, f.h.seq)) emit(f.buf, f.h, true);
    }

    if (faults.dropAck) this.receiver.drainAcks();
    this.flush();
    return delivered;
  }

  feedHex(hex) {
    this.receiver.feed(Buffer.from(hex, 'hex'));
    this.flush();
  }

  flush() {
    for (const l of this.receiver.drainLines()) this.ledger.onLineReceived(l.batchId, l.lineNo);
    for (const b of this.receiver.drainCompleted()) this.ledger.onBatchComplete(b);
    const ackBufs = this.receiver.drainAcks();
    if (ackBufs.length) {
      const { frames } = parseFrames(Buffer.concat(ackBufs));
      for (const f of frames) this.sender.onAck(f.batchId, f.ack);
    }
  }

  tick(ms) {
    this.clock.advance(ms);
  }

  result() {
    return this.ledger.result();
  }
}

module.exports = { Engine };
