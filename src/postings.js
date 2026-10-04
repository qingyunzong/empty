'use strict';

const { encodeVarints, decodeVarints } = require('./encoding');

const SKIP_EVERY = 8;

// Encodes a sorted ascending position list as delta+varint bytes with a skip
// list. Each skip entry records the cumulative position *before* posting i and
// the byte offset of posting i's varint, so decoding can resume mid-stream.
function encodePostings(positions) {
  const skips = [];
  const parts = [];
  let prev = 0;
  let offset = 0;
  for (let i = 0; i < positions.length; i++) {
    if (i > 0 && i % SKIP_EVERY === 0) {
      skips.push({ pos: prev, off: offset });
    }
    const delta = positions[i] - prev;
    prev = positions[i];
    const buf = encodeVarints([delta]);
    parts.push(buf);
    offset += buf.length;
  }
  return {
    count: positions.length,
    data: Buffer.concat(parts).toString('base64'),
    skips,
  };
}

// Decodes positions >= minPos, using the skip list to avoid decoding the
// whole list when a lower bound is known.
function decodePostings(entry, minPos = 0) {
  const buf = Buffer.from(entry.data, 'base64');
  let prev = 0;
  let offset = 0;
  if (minPos > 0) {
    for (const skip of entry.skips) {
      if (skip.pos <= minPos) {
        prev = skip.pos;
        offset = skip.off;
      } else {
        break;
      }
    }
  }
  const { values } = decodeVarints(buf, Infinity, offset);
  const out = [];
  for (const delta of values) {
    prev += delta;
    if (prev >= minPos) out.push(prev);
  }
  return out;
}

module.exports = { encodePostings, decodePostings, SKIP_EVERY };
