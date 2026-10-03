#!/usr/bin/env node
'use strict';

// Generates sample binary frame streams for manual CLI runs.
// Usage: node tools/gen_stream.js --out s.bin --scenario ok|abort|conflict|truncated|badcrc [--seed 1]

const fs = require('node:fs');
const { encode, TYPE } = require('../lib/frame');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledChunks(payload, rand, maxChunk = 700) {
  const chunks = [];
  let off = 0;
  while (off < payload.length) {
    const n = 1 + Math.floor(rand() * Math.min(maxChunk, payload.length - off));
    chunks.push({ offset: off, payload: payload.subarray(off, off + n) });
    off += n;
  }
  for (let i = chunks.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
  }
  return chunks;
}

function dataFrames(board, session, chunks, rand, { duplicates = 1 } = {}) {
  const frames = chunks.map((c) => encode({ type: TYPE.DATA, board, session, offset: c.offset, payload: c.payload }));
  for (let d = 0; d < duplicates && chunks.length; d++) {
    const c = chunks[Math.floor(rand() * chunks.length)];
    frames.push(encode({ type: TYPE.DATA, board, session, offset: c.offset, payload: c.payload }));
  }
  return frames;
}

function build(scenario, seed) {
  const rand = mulberry32(seed);
  const payload = Buffer.alloc(4096);
  for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(rand() * 256);
  const chunks = shuffledChunks(payload, rand);
  const frames = [];
  switch (scenario) {
    case 'ok':
      frames.push(...dataFrames(1, 1, chunks, rand));
      frames.push(encode({ type: TYPE.END, board: 1, session: 1 }));
      break;
    case 'abort':
      frames.push(...dataFrames(1, 1, chunks.slice(0, 3), rand, { duplicates: 0 }));
      frames.push(encode({ type: TYPE.ABORT, board: 1, session: 1, payload: Buffer.from('nozzle_jam') }));
      frames.push(...dataFrames(1, 2, chunks, rand));
      frames.push(encode({ type: TYPE.END, board: 1, session: 2 }));
      break;
    case 'conflict':
      frames.push(...dataFrames(1, 1, chunks, rand));
      frames.push(encode({ type: TYPE.END, board: 1, session: 1 }));
      frames.push(encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload: payload.subarray(0, 10) }));
      break;
    case 'truncated': {
      frames.push(...dataFrames(1, 1, chunks, rand));
      frames.push(encode({ type: TYPE.END, board: 1, session: 1 }));
      const half = encode({ type: TYPE.DATA, board: 2, session: 1, offset: 0, payload: payload.subarray(0, 100) });
      frames.push(half.subarray(0, Math.floor(half.length / 2)));
      break;
    }
    case 'badcrc':
      frames.push(...dataFrames(1, 1, chunks.slice(0, 3), rand, { duplicates: 0 }));
      frames.push(encode({ type: TYPE.DATA, board: 1, session: 1, offset: chunks[3].offset, payload: chunks[3].payload, corruptCrc: true }));
      frames.push(...dataFrames(1, 1, chunks.slice(3), rand, { duplicates: 0 }));
      frames.push(encode({ type: TYPE.END, board: 1, session: 1 }));
      break;
    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }
  return Buffer.concat(frames);
}

const args = process.argv.slice(2);
let out = 's.bin';
let scenario = 'ok';
let seed = 1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--scenario') scenario = args[++i];
  else if (args[i] === '--seed') seed = Number(args[++i]);
}
fs.writeFileSync(out, build(scenario, seed));
console.error(`wrote ${out} scenario=${scenario} seed=${seed}`);
