#!/usr/bin/env node
'use strict';

// Emits a sample frames stream (hex) on stdout, including an out-of-order
// delivery and a retransmitted duplicate. Usage:
//   node examples/make-frames.js > frames.hex
//   node cli.js frames.hex --export pkg.json

const { signEvent, encodeFrame } = require('../src/frame');

let seq = 0;
function ev(batch, item, lamport, kind, ref, qty, reason) {
  return { batch, item, seq: seq++, lamport, kind, ref, qty, reason };
}

const aPack = ev('B1', 'ITEM-A', 1, 'PACK', null, 10, null);
const aRework = ev('B1', 'ITEM-A', 2, 'REWORK', null, 10, 'relabel');
const aCorrect = ev('B1', 'ITEM-A', 3, 'CORRECT', signEvent(aPack).id, 12, 'miscount');
const bPack = ev('B1', 'ITEM-B', 4, 'PACK', null, 5, null);
const bScrap = ev('B1', 'ITEM-B', 5, 'SCRAP', null, 5, 'damaged');
const bAudit = ev('B1', 'ITEM-B', 6, 'CORRECT', signEvent(bScrap).id, 4, 'audit');

// Deliberately out of order, with aCorrect delivered twice (retransmission).
const delivery = [aCorrect, aPack, bPack, aRework, bScrap, aCorrect, bAudit];

const bytes = Buffer.concat(delivery.map((fields) => encodeFrame(fields)));
process.stdout.write(bytes.toString('hex') + '\n');
