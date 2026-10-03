'use strict';
// Generates examples/demo.frames.bin: postings, a resend, an out-of-order
// delivery, a correction chain, a period close, and a late arrival.
const fs = require('fs');
const path = require('path');
const { encodeStream } = require('../lib/frames');

const ev = (eventId, acct, amount, branchSeq, logicalTs, extra = {}) =>
  ({ type: 'event', eventId, acct, amount, branchSeq, logicalTs, ...extra });
const close = (periodId, cutoff) => ({ type: 'close', periodId, cutoff });

const frames = [
  ev('e1', 'A', 10000, 1, 10),            // +100.00 to A
  ev('e2', 'B', 25000, 1, 20),            // +250.00 to B
  ev('e1', 'A', 10000, 1, 10),            // resend of e1 (deduped)
  ev('e4', 'A', -1500, 3, 40),            // arrives before e3 (out of order)
  ev('e3', 'A', 5000, 2, 30),             // fills the branchSeq gap
  ev('e5', 'B', 24000, 2, 50, { replaces: 'e2' }), // correct e2: 250.00 -> 240.00
  ev('e6', 'C', 7000, 1, 60, { causes: ['e5'] }),  // causally after e5
  close('P1', 100),                       // close period P1 at logicalTs 100
  ev('e7', 'A', 300, 4, 80),              // late for P1 (ts 80 <= 100): goes to P2
  ev('e8', 'C', 1250, 2, 110),            // next-period posting
];

const file = path.join(__dirname, 'demo.frames.bin');
fs.writeFileSync(file, encodeStream(frames));
console.log(`wrote ${file} (${frames.length} frames)`);
