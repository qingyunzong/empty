'use strict';

// Generates examples/frames.bin demonstrating: normal posts, a same-key
// retransmission, out-of-order delivery, a close, a reversal+replacement
// correction of a frozen period-1 event, and a late event after close.

const fs = require('node:fs');
const path = require('node:path');
const { withChecksum, encodeFrames } = require('../lib/frame');

const ev = (eventId, acct, amount, branchSeq, logicalTs, extra = {}) =>
  withChecksum({ eventId, acct, amount, branchSeq, logicalTs, ...extra });

const e1 = ev('e1', 'acct-A', 100, 1, 1);
const e2 = ev('e2', 'acct-A', -30, 2, 2);
const e3 = ev('e3', 'acct-B', 50, 1, 3);
const e5 = ev('e5', 'acct-B', 20, 3, 5); // delivered before e4 (out of order)
const e4 = ev('e4', 'acct-B', -10, 2, 4);
const e6 = ev('e6', 'acct-A', 0, 3, 10, { reversalOf: 'e1' }); // reversal of frozen e1
const e7 = ev('e7', 'acct-A', 60, 4, 11, { replaces: 'e1' }); // replacement for e1
const e8 = ev('e8', 'acct-B', 7, 4, 6); // late event (logicalTs 6) after close

const frames = [
  e1,
  e2,
  e2, // same-key retransmission: deduplicated
  e3,
  e5, // buffered: seq 3 arrives before seq 2
  e4, // fills the gap, drains e4 then e5
  { type: 'close' }, // period 1 closes here
  e6,
  e7,
  e8, // late: lands in period 2, period 1 stays frozen
];

const out = path.join(__dirname, 'frames.bin');
fs.writeFileSync(out, encodeFrames(frames));
console.log(`wrote ${out} (${frames.length} frames)`);
