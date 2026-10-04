'use strict';
// Builds examples/demo/frames.bin: an in-order chain (with an undo), delivered
// with one out-of-order frame, one retransmission and one expired lease.
const fs = require('node:fs');
const path = require('node:path');
const { Terminal } = require('../lib/terminal');
const { encodeFrame } = require('../lib/frame');

const outDir = process.argv[2] || path.join(__dirname, '..', 'examples', 'demo');
fs.mkdirSync(outDir, { recursive: true });

const ops = [
  { opId: 'a'.repeat(32), actor: 'alice', seq: 1, cmd: 'set', args: { key: 'site', value: 'cn' } },
  { opId: 'b'.repeat(32), actor: 'alice', seq: 2, cmd: 'set', args: { key: 'env', value: 'prod' } },
  { opId: 'c'.repeat(32), actor: 'bob', seq: 1, cmd: 'set', args: { key: 'version', value: 7 } },
  { opId: 'd'.repeat(32), actor: 'alice', seq: 3, cmd: 'undo', args: { opId: 'b'.repeat(32) } },
  { opId: 'e'.repeat(32), actor: 'bob', seq: 2, cmd: 'del', args: { key: 'version' } },
  { opId: 'f'.repeat(32), actor: 'alice', seq: 4, cmd: 'set', args: { key: 'env', value: 'staging' }, leaseUntil: 2 },
];

// Chain prevHash through a reference (in-memory) terminal in commit order.
const ref = new Terminal(null);
const frames = ops.map((op) => {
  const frame = { ack: 0, leaseUntil: 1000, ...op, prevHash: ref.log.headHash };
  const events = ref.submit(frame);
  if (!events.some((e) => e.status === 'applied' || e.status === 'rejected')) throw new Error('reference stuck on ' + op.opId);
  return frame;
});

// Delivery order: f4 (undo) arrives before f3, f1 is retransmitted, f6's lease expired.
const delivery = [frames[0], frames[1], frames[3], frames[2], frames[4], frames[5], frames[0]];
fs.writeFileSync(path.join(outDir, 'frames.bin'), Buffer.concat(delivery.map(encodeFrame)));
console.log('wrote', path.join(outDir, 'frames.bin'), '(' + delivery.length + ' frames)');
