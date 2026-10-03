'use strict';
// Builds examples/trace.hex: sticky frames, one out-of-order gap with a
// retransmission, one duplicate, and a valid UNDO.
const fs = require('node:fs');
const path = require('node:path');
const { encodeFrame, TYPE } = require('../lib/frame');

const f = (seq, type, payload) => encodeFrame({ type: TYPE[type], seq, ack: 0, payload });

const frames = [
  f(0, 'WELD_START', { orderId: 'ORD-1001', weldId: 'W-01' }),
  f(2, 'WELD_START', { orderId: 'ORD-1002', weldId: 'W-02' }), // out of order: gap at seq 1
  f(1, 'WELD_END', { orderId: 'ORD-1001', weldId: 'W-01' }),   // retransmitted, fills gap
  f(1, 'WELD_END', { orderId: 'ORD-1001', weldId: 'W-01' }),   // duplicate: dropped
  f(3, 'WELD_END', { orderId: 'ORD-1002', weldId: 'W-02' }),
  f(4, 'UNDO', { orderId: 'ORD-1002', targetSeq: 3 }),         // reverse the W-02 end
];

const hex = Buffer.concat(frames).toString('hex');
const wrapped = hex.replace(/(.{64})/g, '$1\n');
fs.writeFileSync(path.join(__dirname, 'trace.hex'), `${wrapped}\n`);
console.log(`wrote examples/trace.hex (${hex.length / 2} bytes, ${frames.length} frames)`);
