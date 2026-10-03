'use strict';

const { TYPES, encodeFrame } = require('../lib/frame');
const { fragmentFrame } = require('../lib/link');

const A = 0; const B = 1; const C = 2; const D = 3;

function obl(cycle, from, to, ccy, amount, seq) {
  return { type: TYPES.OBLIGATION, cycle, from, to, ccy, amount: BigInt(amount), seq, reason: 0 };
}
function ack(cycle, from, to, seq) {
  return { type: TYPES.ACK, cycle, from, to, ccy: 'USD', amount: 0n, seq, reason: 0 };
}
function nak(cycle, from, to, seq, reason) {
  return { type: TYPES.NAK, cycle, from, to, ccy: 'USD', amount: 0n, seq, reason };
}
function cancel(cycle, from, seq) {
  return { type: TYPES.CANCEL, cycle, from, to: 0, ccy: 'USD', amount: 0n, seq, reason: 0 };
}
function tick(deltaMs) {
  return { type: TYPES.TICK, cycle: 0, from: 0, to: 0, ccy: 'USD', amount: BigInt(deltaMs), seq: 0, reason: 0 };
}

// Deterministic shuffle (LCG) so tests are reproducible.
function shuffled(arr, seed = 42) {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Encode frames into a link stream: fragmented, with duplicate
// retransmitted fragments and out-of-order delivery.
function streamOf(frames, { fragSize = 8, duplicates = true, shuffle = true, seed = 42 } = {}) {
  // Tick frames drive the local virtual clock: they are appended in order at
  // the end and never take part in link-layer reordering.
  const data = frames.filter((f) => f.type !== 5);
  const ticks = frames.filter((f) => f.type === 5);
  let packets = [];
  const all = [...data, ...ticks];
  all.forEach((f, i) => {
    const pkts = fragmentFrame(encodeFrame(f), i + 1, fragSize);
    if (f.type === 5) return; // handled below
    packets.push(...pkts);
    if (duplicates) packets.push(pkts[0]); // retransmission of first fragment
  });
  if (shuffle) packets = shuffled(packets, seed);
  for (const f of ticks) {
    packets.push(...fragmentFrame(encodeFrame(f), all.indexOf(f) + 1, fragSize));
  }
  return Buffer.concat(packets);
}

module.exports = { A, B, C, D, obl, ack, nak, cancel, tick, shuffled, streamOf };
