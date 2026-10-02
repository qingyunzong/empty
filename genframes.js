'use strict';

// Generates the demo scenario used in README.md:
//   node genframes.js frames.bin && node cli.js frames.bin
const fs = require('fs');
const { encodeFrame, TYPE } = require('./frame');

const frames = [
  { type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 600, seq: 1 }, // accept 600
  { type: TYPE.RESERVE, member: 'BOB', reqId: 1, amount: 700, seq: 1 },   // partial 400
  { type: TYPE.RESERVE, member: 'CAROL', reqId: 1, amount: 100, seq: 1 }, // reject, over budget
  { type: TYPE.COMMIT, member: 'ALICE', reqId: 1, amount: 600, seq: 2 },  // consume reservation
  { type: TYPE.COMMIT, member: 'ALICE', reqId: 1, amount: 600, seq: 2 },  // retransmission -> dup
  { type: TYPE.RELEASE, member: 'BOB', reqId: 1, amount: 400, seq: 2 },   // free 400
  { type: TYPE.RELEASE, member: 'DAVE', reqId: 2, amount: 200, seq: 1 },  // release before reserve -> buffered
  { type: TYPE.RESERVE, member: 'DAVE', reqId: 2, amount: 200, seq: 2 },  // reserve, pending release applies
  { type: TYPE.COMMIT, member: 'ERIN', reqId: 1, amount: 50, seq: 2 },    // out-of-order: seq 2 before seq 1
  { type: TYPE.RESERVE, member: 'ERIN', reqId: 1, amount: 100, seq: 1 },  // holdback drains: reserve then commit
  { type: TYPE.RESERVE, member: 'ALICE', reqId: 2, amount: 100, seq: 3 }, // expires at t=100
  { type: TYPE.EXPIRE, member: 'SYS', reqId: 0, amount: 100, seq: 1 },    // virtual clock -> 100
  { type: TYPE.COMMIT, member: 'ALICE', reqId: 2, amount: 100, seq: 4 },  // late commit -> reject expired
  { type: TYPE.COMMIT, member: 'EVE', reqId: 9, amount: 50, seq: 1 },     // unknown reqId -> reject
];

const out = process.argv[2] || 'frames.bin';
fs.writeFileSync(out, Buffer.concat(frames.map(encodeFrame)));
console.log(`wrote ${frames.length} frames to ${out}`);
