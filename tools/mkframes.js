'use strict';

// Generates the example frame streams under examples/.
// Usage: node tools/mkframes.js

const fs = require('fs');
const path = require('path');
const { TYPE, encodeFrame, fragmentFrame } = require('../lib/frame');

const OUT = path.join(__dirname, '..', 'examples');
fs.mkdirSync(OUT, { recursive: true });

const F = (type, member, reqId, amount, seq, tick, ack = 0) =>
  encodeFrame({ type, member, reqId, amount, seq, ack, tick });

function write(name, buffers) {
  fs.writeFileSync(path.join(OUT, name), Buffer.concat(buffers));
  console.log(`wrote examples/${name} (${buffers.length} record(s))`);
}

// --- demo.bin: accept / partial / commit / release / TTL expire / late commit
const demo = [
  F(TYPE.RESERVE, 'alice', 1, 400, 1, 0),   // accept 400
  F(TYPE.RESERVE, 'bob', 2, 500, 2, 0),     // accept 500
  F(TYPE.RESERVE, 'carol', 3, 300, 3, 1),   // partial 100 (budget 1000)
  F(TYPE.COMMIT, 'alice', 1, 400, 4, 2),    // commit 400
  F(TYPE.RELEASE, 'bob', 2, 0, 5, 3),       // release 500
  F(TYPE.RESERVE, 'erin', 4, 100, 6, 10),   // accept 100, expires at tick 60 (ttl 50)
  F(TYPE.RESERVE, 'frank', 5, 50, 7, 100),  // auto-expire erin first, then accept 50
  F(TYPE.COMMIT, 'erin', 4, 100, 8, 101),   // reject: reservation expired
];
write('demo.bin', demo);

// --- frag.bin: identical logical stream to demo.bin, but fragmented,
// --- retransmitted and delivered out of order. Must produce identical output.
const frag = [];
frag.push(...fragmentFrame(demo[1], 'bob', 2, 15));        // seq 2 fragmented, arrives first
frag.push(demo[0]);                                        // seq 1 -> delivers 1,2
frag.push(demo[1]);                                        // retransmission of seq 2 -> dropped
frag.push(demo[3]);                                        // seq 4 -> buffered (gap at 3)
frag.push(...fragmentFrame(demo[2], 'carol', 3, 20));      // seq 3 fragmented -> delivers 3,4
frag.push(demo[4], demo[5], demo[6], demo[7]);             // seq 5..8 in order
write('frag.bin', frag);

// --- overbudget.bin: three equal reserves at the same tick, budget 1000.
// --- Tie broken by member lexicographic order: alice, bob, carol.
write('overbudget.bin', [
  F(TYPE.RESERVE, 'carol', 3, 600, 1, 0),
  F(TYPE.RESERVE, 'alice', 1, 600, 2, 0),
  F(TYPE.RESERVE, 'bob', 2, 600, 3, 0),
]);

// --- unknown.bin: commit for a reqId that never gets reserved.
write('unknown.bin', [F(TYPE.COMMIT, 'alice', 99, 10, 1, 0)]);

// --- corrupt.bin: one valid frame followed by a crc-tampered frame.
const bad = Buffer.from(F(TYPE.RESERVE, 'alice', 1, 100, 2, 0));
bad[20] ^= 0xff;
write('corrupt.bin', [F(TYPE.RESERVE, 'alice', 1, 100, 1, 0), bad]);
