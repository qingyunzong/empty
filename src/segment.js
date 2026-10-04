'use strict';

const zlib = require('node:zlib');
const { encodeVarints, decodeVarints } = require('./encoding');
const { encodePostings } = require('./postings');

const BLOCK_SIZE = 16;

// A frozen segment: events grouped into deflate-compressed varint blocks,
// plus a per-device token -> postings index with skip pointers.
//
// {
//   format, id, dictVersion, from, to, count,
//   devices: [name, ...],
//   bases:   { device: absolute token position of this segment's first token },
//   blocks:  [base64(deflate(varints)), ...],
//   postings:{ device: { tokenId: { count, data, skips } } }
// }
function encodeSegment({ id, dictVersion, events, bases, dictTerms }) {
  const tokenId = new Map(dictTerms.map((t, i) => [t, i]));
  const devices = [...new Set(events.map((e) => e.device))];
  const deviceId = new Map(devices.map((d, i) => [d, i]));

  const blocks = [];
  for (let start = 0; start < events.length; start += BLOCK_SIZE) {
    const chunk = events.slice(start, start + BLOCK_SIZE);
    const nums = [chunk.length];
    let prevTs = 0;
    for (const ev of chunk) {
      nums.push(deviceId.get(ev.device));
      nums.push(ev.ts - prevTs);
      prevTs = ev.ts;
      nums.push(ev.seq);
      nums.push(ev.tokens.length);
      for (const tok of ev.tokens) {
        const idNum = tokenId.get(tok);
        if (idNum === undefined) {
          throw new Error(`token not in dictionary: ${tok}`);
        }
        nums.push(idNum);
      }
    }
    blocks.push(zlib.deflateSync(encodeVarints(nums)).toString('base64'));
  }

  // Per-device postings over absolute positions.
  const postings = {};
  const offsets = {};
  for (const dev of devices) {
    postings[dev] = {};
    offsets[dev] = bases[dev] || 0;
  }
  for (const ev of events) {
    const base = offsets[ev.device];
    for (let j = 0; j < ev.tokens.length; j++) {
      const tid = tokenId.get(ev.tokens[j]);
      const key = String(tid);
      if (!postings[ev.device][key]) postings[ev.device][key] = [];
      postings[ev.device][key].push(base + j);
    }
    offsets[ev.device] += ev.tokens.length;
  }
  for (const dev of devices) {
    for (const key of Object.keys(postings[dev])) {
      postings[dev][key] = encodePostings(postings[dev][key]);
    }
  }

  return {
    format: 1,
    id,
    dictVersion,
    from: events[0].ts,
    to: events[events.length - 1].ts,
    count: events.length,
    devices,
    bases,
    blocks,
    postings,
  };
}

function decodeSegment(seg, dictTerms) {
  const events = [];
  for (const block of seg.blocks) {
    const buf = zlib.inflateSync(Buffer.from(block, 'base64'));
    const { values } = decodeVarints(buf);
    let i = 0;
    const n = values[i++];
    let prevTs = 0;
    for (let e = 0; e < n; e++) {
      const dev = seg.devices[values[i++]];
      const ts = prevTs + values[i++];
      prevTs = ts;
      const seq = values[i++];
      const nTokens = values[i++];
      const tokens = [];
      for (let j = 0; j < nTokens; j++) {
        tokens.push(dictTerms[values[i++]]);
      }
      events.push({ ts, device: dev, seq, tokens });
    }
  }
  return events;
}

module.exports = { encodeSegment, decodeSegment, BLOCK_SIZE };
