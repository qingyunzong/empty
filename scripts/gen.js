'use strict';

// Generates example frame streams into examples/.
// Usage: node scripts/gen.js

const fs = require('node:fs');
const path = require('node:path');
const { encodeStream } = require('../lib/frame');

const KEY = 'hotel-preauth-secret';
const OUT = path.join(__dirname, '..', 'examples');

const f = (authId, type, amount, seq, ack = 0) => ({ authId, type, amount, seq, ack });

const examples = {
  // 1. inc exceeds limit -> partial accept
  'ex1-inc-partial.bin': {
    args: '--limit 1000',
    frames: [f('A', 'hold', 500, 1), f('A', 'inc', 700, 2), f('A', 'complete', 900, 3)],
  },
  // 2. dec/complete race: complete(seq 3) arrives before dec(seq 2);
  //    dec is clamped so frozen stays >= completion candidate 600.
  'ex2-dec-complete-race.bin': {
    args: '--limit 2000',
    frames: [f('A', 'hold', 1000, 1), f('A', 'complete', 600, 3), f('A', 'dec', 500, 2)],
  },
  // 3. duplicate complete: retransmitted seq 2 is idempotent;
  //    a *new* complete (seq 3) after COMPLETED is rejected but recorded.
  'ex3-dup-complete.bin': {
    args: '--limit 1000',
    frames: [
      f('A', 'hold', 800, 1), f('A', 'complete', 500, 2),
      f('A', 'complete', 500, 2), f('A', 'complete', 600, 3),
    ],
  },
  // 4. timeout: ttl 3, auth A expires while B's frames tick the clock;
  //    late inc and late complete are rejected with evidence.
  'ex4-timeout.bin': {
    args: '--limit 1000 --ttl 3',
    frames: [
      f('A', 'hold', 400, 1),
      f('B', 'hold', 100, 1), f('B', 'inc', 50, 2), f('B', 'dec', 20, 3),
      f('A', 'inc', 100, 2),   // late: A auto-voided at tick 5
      f('A', 'complete', 300, 3), // late complete: rejected, evidence kept
    ],
  },
  // 5. reverse: only a COMPLETED auth can be reversed; generates reverse ledger.
  'ex5-reverse.bin': {
    args: '--limit 1000',
    frames: [
      f('A', 'hold', 900, 1), f('A', 'complete', 400, 2),
      f('A', 'reverse', 400, 3), f('A', 'reverse', 400, 4),
    ],
  },
  // 6. mac error -> exit 2
  'ex6-mac-error.bin': {
    args: '',
    frames: [f('A', 'hold', 100, 1), f('A', 'inc', 50, 2)],
    corrupt: (buf) => { buf[buf.length - 1] ^= 0xff; return buf; },
  },
  // 7. conflict: same seq, different payload -> exit 3
  'ex7-conflict.bin': {
    args: '',
    frames: [f('A', 'hold', 100, 1), f('A', 'inc', 50, 2), f('A', 'inc', 60, 2)],
  },
  // 8. negative frozen: complete exceeds frozen -> exit 4
  'ex8-negative-frozen.bin': {
    args: '--limit 1000',
    frames: [f('A', 'hold', 300, 1), f('A', 'complete', 500, 2)],
  },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, ex] of Object.entries(examples)) {
  let buf = encodeStream(ex.frames, KEY);
  if (ex.corrupt) buf = ex.corrupt(buf);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`wrote examples/${name}  (args: ${ex.args || '(none)'})`);
}
