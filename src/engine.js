'use strict';

const frame = require('./frame');
const { Sender, Receiver } = require('./protocol');
const { Ledger, BusinessError } = require('./ledger');
const { VirtualClock } = require('./clock');

// Ties the wire protocol, the lossy link and the business ledger together.
// The engine models one bank (sender) talking to one settlement node
// (receiver) over a link whose queue can be reordered, dropped, duplicated,
// split or corrupted via `link` commands. ACK frames loop back directly;
// lost DATA frames are recovered by timeout retransmission.
class Engine {
  constructor() {
    this.clock = new VirtualClock();
    this.sender = new Sender(this.clock, { rtoMs: 1000 });
    this.receiver = new Receiver();
    this.decoder = new frame.FrameDecoder();
    this.ledger = new Ledger(this.clock, { batchTimeoutMs: 10000 });
    this.link = []; // outbound frame/segment buffers, in transmit order
    this.stats = { dropped: 0, duplicated: 0, corrupted: 0, split: 0, lateDeliveries: 0 };
  }

  exec(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.op !== 'string') {
      throw new frame.ProtocolError('command must be an object with a string "op"', 'BAD_INPUT');
    }
    switch (cmd.op) {
      case 'config': return this.cmdConfig(cmd);
      case 'account': return this.ledger.addAccount(cmd.id, cmd.balance);
      case 'submit': return this.ledger.submitBatch(cmd.batchId, cmd.lines);
      case 'send': return this.cmdSend(cmd);
      case 'link': return this.cmdLink(cmd);
      case 'deliver': return this.cmdDeliver(cmd);
      case 'tick': return this.cmdTick(cmd);
      case 'settle': return this.ledger.settle(cmd.batchId, cmd.lineNo);
      case 'settle_batch': return this.cmdSettleBatch(cmd);
      case 'nak': return this.ledger.nak(cmd.batchId, cmd.lineNo);
      default:
        throw new frame.ProtocolError(`unknown op "${cmd.op}"`, 'BAD_INPUT');
    }
  }

  cmdConfig(cmd) {
    if (cmd.rtoMs !== undefined) this.sender.rtoMs = cmd.rtoMs;
    if (cmd.batchTimeoutMs !== undefined) this.ledger.batchTimeoutMs = cmd.batchTimeoutMs;
  }

  cmdSend(cmd) {
    const batch = this.ledger.batches.get(cmd.batchId);
    if (!batch) throw new BusinessError(`unknown batch ${cmd.batchId}`);
    const lineNos = cmd.lines !== undefined ? cmd.lines : [...batch.lines.keys()];
    for (const lineNo of lineNos) {
      const line = batch.lines.get(lineNo);
      if (!line) throw new BusinessError(`unknown line ${cmd.batchId}/${lineNo}`);
      const rec = this.sender.dataFrame(cmd.batchId, lineNo, {
        batchId: line.batchId, lineNo: line.lineNo,
        from: line.from, to: line.to, amount: line.amount,
        reversalOf: line.reversalOf,
      });
      this.link.push(this.sender.encode(rec));
    }
  }

  cmdLink(cmd) {
    const q = this.link;
    const at = (i) => {
      if (!Number.isInteger(i) || i < 0 || i >= q.length) {
        throw new frame.ProtocolError(`link index ${i} out of range (queue length ${q.length})`, 'BAD_INPUT');
      }
      return i;
    };
    switch (cmd.action) {
      case 'drop':
        q.splice(at(cmd.index), 1);
        this.stats.dropped++;
        break;
      case 'dup':
        q.splice(at(cmd.index), 0, Buffer.from(q[cmd.index]));
        this.stats.duplicated++;
        break;
      case 'swap': {
        const i = at(cmd.i), j = at(cmd.j);
        [q[i], q[j]] = [q[j], q[i]];
        break;
      }
      case 'split': {
        const i = at(cmd.index);
        if (!Number.isInteger(cmd.at) || cmd.at <= 0 || cmd.at >= q[i].length) {
          throw new frame.ProtocolError('split point must be inside the frame', 'BAD_INPUT');
        }
        q.splice(i, 1, q[i].subarray(0, cmd.at), q[i].subarray(cmd.at));
        this.stats.split++;
        break;
      }
      case 'corrupt': {
        const i = at(cmd.index);
        const copy = Buffer.from(q[i]);
        copy[copy.length >> 1] ^= 0xFF;
        q[i] = copy;
        this.stats.corrupted++;
        break;
      }
      case 'raw':
        if (typeof cmd.hex !== 'string' || !/^[0-9a-fA-F]*$/.test(cmd.hex) || cmd.hex.length % 2 !== 0) {
          throw new frame.ProtocolError('raw action requires an even-length hex string', 'BAD_INPUT');
        }
        q.push(Buffer.from(cmd.hex, 'hex'));
        break;
      default:
        throw new frame.ProtocolError(`unknown link action "${cmd.action}"`, 'BAD_INPUT');
    }
  }

  cmdDeliver(cmd) {
    const count = cmd.count === undefined || cmd.count === 'all' ? this.link.length : cmd.count;
    for (let i = 0; i < count && this.link.length > 0; i++) {
      const chunk = this.link.shift();
      for (const f of this.decoder.push(chunk)) this.onFrame(f);
    }
  }

  onFrame(f) {
    if (f.type === frame.TYPE.ACK) {
      this.sender.onAck(f.ack);
      return;
    }
    if (f.type !== frame.TYPE.DATA) {
      throw new frame.ProtocolError(`unknown frame type ${f.type}`);
    }
    const { delivered, ack } = this.receiver.onData(f);
    // ACK loops back to the sender (lossless return path; data loss is
    // recovered by timeout retransmission).
    this.sender.onAck(ack);
    for (const d of delivered) {
      JSON.parse(d.payload.toString('utf8')); // payload must be valid JSON
      if (this.ledger.onDelivered(d.batchId, d.lineNo) === 'ignored') this.stats.lateDeliveries++;
    }
  }

  cmdTick(cmd) {
    this.clock.advance(cmd.ms || 0);
    if (this.sender.retransmitDue()) {
      for (const rec of this.sender.retransmit()) this.link.push(this.sender.encode(rec));
    }
    this.ledger.checkTimeouts();
  }

  cmdSettleBatch(cmd) {
    const batch = this.ledger.batches.get(cmd.batchId);
    if (!batch) throw new BusinessError(`unknown batch ${cmd.batchId}`);
    for (const line of [...batch.lines.values()].sort((a, b) => a.lineNo - b.lineNo)) {
      if (line.state === 'ACKED') this.ledger.settle(cmd.batchId, line.lineNo);
    }
  }

  output() {
    return {
      code: 'OK',
      time: this.clock.now(),
      ...this.ledger.snapshot(),
      stats: {
        framesSent: this.sender.stats.sent,
        retransmits: this.sender.stats.retransmits,
        duplicates: this.receiver.stats.duplicates,
        outOfOrder: this.receiver.stats.outOfOrder,
        crcErrors: this.decoder.stats.crcErrors,
        resyncs: this.decoder.stats.resyncs,
        dropped: this.stats.dropped,
        corrupted: this.stats.corrupted,
        split: this.stats.split,
        lateDeliveries: this.stats.lateDeliveries,
      },
    };
  }
}

module.exports = { Engine };
