'use strict';
// Generates sample .bin files into samples/.
const fs = require('fs');
const path = require('path');
const { encodeFrame, encodePacket, buildFile, FRAME_TYPES } = require('../wire');

const OUT = path.join(__dirname, '..', 'samples');

// Packets builder: assigns linkSeq in given order, supports fragmentation.
class PktBuilder {
  constructor() { this.linkSeq = 1; this.fragId = 1; this.packets = []; }
  frame(f, fragSizes) {
    const buf = encodeFrame(f);
    const fragId = this.fragId++;
    if (!fragSizes) {
      this.packets.push(encodePacket({
        linkSeq: this.linkSeq++, fragId, fragIndex: 0, fragCount: 1, payload: buf,
      }));
    } else {
      let off = 0;
      fragSizes.forEach((size, i) => {
        this.packets.push(encodePacket({
          linkSeq: this.linkSeq++, fragId, fragIndex: i, fragCount: fragSizes.length,
          payload: buf.subarray(off, off + size),
        }));
        off += size;
      });
    }
    return this;
  }
  retransmitLast() { this.packets.push(this.packets[this.packets.length - 1]); return this; }
  shuffle(order) { // reorder packets by index list
    this.packets = order.map((i) => this.packets[i]);
    return this;
  }
  build(banks) { return buildFile({ banks, packets: this.packets }); }
}

function write(name, buf) {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`wrote samples/${name} (${buf.length} bytes)`);
}

const O = FRAME_TYPES.OBLIGATION, A = FRAME_TYPES.ACK, N = FRAME_TYPES.NAK, C = FRAME_TYPES.CANCEL;

// 1. three-bank circle, nets to zero
{
  const b = new PktBuilder();
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 1000n, seq: 1 });
  b.frame({ type: O, cycle: 1, from: 'BBB', to: 'CCC', ccy: 'USD', amount: 1000n, seq: 1 });
  b.frame({ type: O, cycle: 1, from: 'CCC', to: 'AAA', ccy: 'USD', amount: 1000n, seq: 1 });
  write('sample1_circle.bin', b.build([
    { id: 'AAA', ccy: 'USD', balance: 0n },
    { id: 'BBB', ccy: 'USD', balance: 0n },
    { id: 'CCC', ccy: 'USD', balance: 0n },
  ]));
}

// 2. duplicate ack + out-of-order nak + fragmentation + retransmission
{
  const b = new PktBuilder();
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 500n, seq: 1 }, [12, 10, 9]); // fragmented
  b.frame({ type: A, cycle: 1, from: 'BBB', to: 'AAA', ccy: 'USD', amount: 0n, seq: 1 });
  b.frame({ type: A, cycle: 1, from: 'BBB', to: 'AAA', ccy: 'USD', amount: 0n, seq: 1 }); // duplicate ack
  b.frame({ type: O, cycle: 1, from: 'CCC', to: 'AAA', ccy: 'USD', amount: 700n, seq: 1 });
  b.frame({ type: N, cycle: 1, from: 'AAA', to: 'CCC', ccy: 'USD', amount: 0n, seq: 1, reason: 5 }); // nak w/ reason
  b.retransmitLast(); // link retransmission of the nak packet
  // deliver out of order: swap first two packets
  const p = b.packets;
  [p[0], p[1]] = [p[1], p[0]];
  write('sample2_dup_ooo.bin', b.build([
    { id: 'AAA', ccy: 'USD', balance: 10000n },
    { id: 'BBB', ccy: 'USD', balance: 10000n },
    { id: 'CCC', ccy: 'USD', balance: 10000n },
  ]));
}

// 3. insufficient liquidity -> whole-ccy unwind, EUR still settles
{
  const b = new PktBuilder();
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 4000n, seq: 1 });
  b.frame({ type: O, cycle: 1, from: 'BBB', to: 'CCC', ccy: 'USD', amount: 9000n, seq: 1 });
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'CCC', ccy: 'EUR', amount: 200n, seq: 2 });
  write('sample3_unwind.bin', b.build([
    { id: 'AAA', ccy: 'USD', balance: 5000n },
    { id: 'AAA', ccy: 'EUR', balance: 1000n },
    { id: 'BBB', ccy: 'USD', balance: 4000n },
    { id: 'CCC', ccy: 'USD', balance: 0n },
    { id: 'CCC', ccy: 'EUR', balance: 0n },
  ]));
}

// 4. late cancel at close boundary
{
  const b = new PktBuilder();
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 800n, seq: 1 });
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 300n, seq: 2 });
  b.frame({ type: C, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 0n, seq: 2 }); // cancels seq 2 in time
  b.frame({ type: O, cycle: 2, from: 'BBB', to: 'AAA', ccy: 'USD', amount: 100n, seq: 1 }); // closes cycle 1
  b.frame({ type: C, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 0n, seq: 1 }); // late cancel -> routed to cycle 2
  write('sample4_late_cancel.bin', b.build([
    { id: 'AAA', ccy: 'USD', balance: 10000n },
    { id: 'BBB', ccy: 'USD', balance: 10000n },
  ]));
}

// 5. negative obligation -> exit 4
{
  const b = new PktBuilder();
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: -50n, seq: 1 });
  write('sample5_negative.bin', b.build([
    { id: 'AAA', ccy: 'USD', balance: 1000n },
    { id: 'BBB', ccy: 'USD', balance: 1000n },
  ]));
}

// 6. unknown cycle (gap 1 -> 3) -> exit 3
{
  const b = new PktBuilder();
  b.frame({ type: O, cycle: 3, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 50n, seq: 1 });
  write('sample6_unknown_cycle.bin', b.build([
    { id: 'AAA', ccy: 'USD', balance: 1000n },
    { id: 'BBB', ccy: 'USD', balance: 1000n },
  ]));
}

// 7. corrupted crc -> exit 2
{
  const b = new PktBuilder();
  b.frame({ type: O, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 50n, seq: 1 });
  const buf = b.build([
    { id: 'AAA', ccy: 'USD', balance: 1000n },
    { id: 'BBB', ccy: 'USD', balance: 1000n },
  ]);
  buf[buf.length - 1] ^= 0xff; // corrupt last crc byte
  write('sample7_bad_crc.bin', buf);
}
