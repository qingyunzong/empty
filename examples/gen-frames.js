'use strict';
// Generates examples/frames.bin demonstrating: normal ops, a retransmission
// (duplicate opId), an out-of-order frame, an undo, and an expired lease.
const fs = require('fs');
const path = require('path');
const { Engine } = require('../src/engine');
const { encodeFrame, ZERO_HASH } = require('../src/frame');

const ops = [
  { opId: 'a'.repeat(32), actor: 'alice', cmd: 'set', args: { key: 'balance', value: 100 } },
  { opId: 'b'.repeat(32), actor: 'bob', cmd: 'inc', args: { key: 'balance', n: -30 } },
  { opId: 'c'.repeat(32), actor: 'alice', cmd: 'undo', args: { target: 'b'.repeat(32) } },
  { opId: 'd'.repeat(32), actor: 'carol', cmd: 'set', args: { key: 'note', value: 'late' }, leaseUntil: 1 }, // will expire
];

// compute prevHash chain from a reference serial run
const ref = new Engine(null);
const frames = [];
ops.forEach((op, i) => {
  const f = { prevHash: i === 0 ? ZERO_HASH : ref.chain.entries[i - 1].hash, seq: i + 1, leaseUntil: 1e9, ...op };
  frames.push(f);
  if (f.leaseUntil >= 1e9) ref.process(f, encodeFrame(f));
});

// arrival order: op1, retransmit op1, op3 (buffered, out of order), op2, op4 (expired lease)
const order = [frames[0], frames[0], frames[2], frames[1], frames[3]];
const blob = Buffer.concat(order.map(encodeFrame));
fs.writeFileSync(path.join(__dirname, 'frames.bin'), blob);
console.log(`wrote ${blob.length} bytes, ${order.length} frames`);
