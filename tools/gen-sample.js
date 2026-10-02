'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeStream } = require('../src/frame');

const KEY = process.env.PA_KEY || 'dev-key';

const frames = [
  { authId: 'ROOM-301', type: 'hold', seq: 1, amount: 800, limit: 1000, ts: 0, ack: 0 },
  { authId: 'ROOM-301', type: 'inc', seq: 2, amount: 500, ts: 10, ack: 1 },
  { authId: 'ROOM-301', type: 'complete', seq: 4, amount: 900, ts: 30, ack: 3 },
  { authId: 'ROOM-301', type: 'dec', seq: 3, amount: 100, ts: 20, ack: 2 },
  { authId: 'ROOM-301', type: 'complete', seq: 4, amount: 900, ts: 30, ack: 3 },
  { authId: 'ROOM-301', type: 'reverse', seq: 5, amount: 150, ts: 40, ack: 4 },
  { authId: 'ROOM-512', type: 'hold', seq: 1, amount: 600, ts: 0, ack: 0 },
  { authId: 'ROOM-512', type: 'inc', seq: 2, amount: 50, ts: 150, ack: 1 },
  { authId: 'ROOM-512', type: 'complete', seq: 3, amount: 300, ts: 160, ack: 2 },
];

const out = path.join(__dirname, '..', 'sample', 'frames.bin');
fs.writeFileSync(out, encodeStream(frames, { key: KEY, fragmentSize: 23 }));
console.log(`wrote ${out} (${frames.length} frames)`);
