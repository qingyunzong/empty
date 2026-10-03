'use strict';

// Generates the example .bin files used in the README.
const fs = require('fs');
const path = require('path');
const { encodeFrame } = require('../lib/frame');
const { streamOf, obl, ack, nak, cancel, tick, A, B, C } = require('../test/helpers');

const out = path.join(__dirname, '..', 'examples');
fs.mkdirSync(out, { recursive: true });

// 1. Full demo: 3-bank circle netting to zero, EUR leg, duplicate ack,
//    out-of-order nak, cancel, cycle close, next-cycle obligation.
const demo = streamOf([
  obl(0, A, B, 'USD', 100, 1),
  obl(0, B, C, 'USD', 100, 1),
  obl(0, C, A, 'USD', 100, 1),
  obl(0, A, C, 'EUR', 40, 2),
  ack(0, B, A, 1),
  ack(0, B, A, 1), // retransmitted duplicate ack
  nak(0, C, A, 3, 3), // out-of-order nak (arrives before the obligation)
  obl(0, A, C, 'EUR', 999, 3), // rejected by the pending nak
  cancel(0, A, 2), // cancel the EUR 40 leg
  tick(60000), // close cycle 0
  obl(1, B, A, 'USD', 25, 2), // next cycle
  tick(60000), // close cycle 1
], { fragSize: 8, seed: 7 });
fs.writeFileSync(path.join(out, 'demo.bin'), demo);

// 2. Unwind demo: A cannot cover its USD net; EUR still settles.
const unwind = streamOf([
  obl(0, A, B, 'USD', 100, 1),
  obl(0, A, C, 'EUR', 20, 2),
  tick(60000),
], { fragSize: 16, duplicates: false, shuffle: false });
fs.writeFileSync(path.join(out, 'unwind.bin'), unwind);

// 3. Late cancel at the close boundary.
// Built manually: the cancel must hit the wire AFTER the first tick.
const { fragmentFrame } = require('../lib/link');
const lateFrames = [
  obl(0, A, B, 'USD', 100, 1),
  tick(60000), // cycle 0 closes and settles
  cancel(0, A, 1), // too late: redirected to cycle 1
  tick(60000),
];
const late = Buffer.concat(lateFrames.flatMap((f, i) => fragmentFrame(encodeFrame(f), i + 1, 16)));
fs.writeFileSync(path.join(out, 'late_cancel.bin'), late);

// 4. Error demos.
const bad = encodeFrame(obl(0, A, B, 'USD', 100, 1));
bad[15] ^= 0xff; // corrupt amount, crc no longer matches
fs.writeFileSync(path.join(out, 'bad_crc.bin'),
  streamOfRaw([bad]));
function streamOfRaw(frames) {
  const { fragmentFrame } = require('../lib/link');
  return Buffer.concat(frames.flatMap((f, i) => fragmentFrame(f, i + 1, 29)));
}
fs.writeFileSync(path.join(out, 'unknown_cycle.bin'),
  streamOfRaw([encodeFrame(obl(7, A, B, 'USD', 100, 1))]));
fs.writeFileSync(path.join(out, 'negative.bin'),
  streamOfRaw([encodeFrame(obl(0, A, B, 'USD', -5n, 1))]));

console.log('wrote examples:', fs.readdirSync(out).join(', '));
