'use strict';
// Generates examples/trace.hex: a sticky frame stream containing a duplicate
// (seq 1 sent twice) and an out-of-order gap (seq 6 before seq 5).
const fs = require('node:fs');
const path = require('node:path');
const { encodeFrame } = require('../src/frame');

const f = (seq, type, wo) => encodeFrame({ seq, type, payload: wo });
const frames = [
  f(0, 'WELD_START', 'WO-1'),
  f(1, 'WELD_END', 'WO-1'),
  f(1, 'WELD_END', 'WO-1'), // duplicate: retransmission, must not double-post
  f(2, 'WELD_START', 'WO-2'),
  f(3, 'WELD_END', 'WO-2'),
  f(4, 'UNDO', 'WO-2'),
  f(6, 'WELD_END', 'WO-3'), // out of order: arrives before seq 5
  f(5, 'WELD_START', 'WO-3'),
];
const hex = Buffer.concat(frames).toString('hex');
const pretty = hex.replace(/(..)/g, '$1 ').trim() + '\n';
fs.writeFileSync(path.join(__dirname, 'trace.hex'), pretty);
console.log(`wrote examples/trace.hex (${hex.length / 2} bytes, ${frames.length} frames)`);
