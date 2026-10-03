'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../lib/gateway');
const { VirtualClock } = require('../lib/clock');
const { encode, TYPE } = require('../lib/frame');
const { merkleRoot } = require('../lib/merkle');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSession(payload, chunks, rand) {
  const order = [...chunks];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const gw = new Gateway({ clock: new VirtualClock() });
  for (const c of order) {
    gw.feed(encode({ type: TYPE.DATA, board: 1, session: 1, offset: c.offset, payload: c.payload }));
    if (rand() < 0.2) { // random retransmit
      gw.feed(encode({ type: TYPE.DATA, board: 1, session: 1, offset: c.offset, payload: c.payload }));
    }
  }
  gw.feed(encode({ type: TYPE.END, board: 1, session: 1 }));
  gw.end();
  return gw.certs()[0];
}

test('acceptance 4: random chunkings always match the one-shot reference', () => {
  const rand = mulberry32(0xC0FFEE);
  for (let iter = 0; iter < 200; iter++) {
    const size = 1 + Math.floor(rand() * 5000);
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = Math.floor(rand() * 256);
    const chunks = [];
    let off = 0;
    while (off < size) {
      const n = 1 + Math.floor(rand() * Math.min(700, size - off));
      chunks.push({ offset: off, payload: payload.subarray(off, off + n) });
      off += n;
    }
    const cert = runSession(payload, chunks, rand);
    assert.equal(cert.status, 'committed');
    assert.equal(cert.merkleRoot, merkleRoot(payload), `iter=${iter} size=${size}`);
    assert.equal(cert.receivedBytes, size);
  }
});

test('acceptance 4: every enumerated offset split matches the reference', () => {
  const n = 12;
  const payload = Buffer.alloc(n);
  for (let i = 0; i < n; i++) payload[i] = (i * 17 + 3) & 0xFF;
  const reference = merkleRoot(payload);
  const rand = mulberry32(42);
  // Enumerate all 2^(n-1) subsets of cut points between bytes.
  for (let mask = 0; mask < (1 << (n - 1)); mask++) {
    const chunks = [];
    let start = 0;
    for (let i = 0; i < n - 1; i++) {
      if (mask & (1 << i)) {
        chunks.push({ offset: start, payload: payload.subarray(start, i + 1) });
        start = i + 1;
      }
    }
    chunks.push({ offset: start, payload: payload.subarray(start) });
    const cert = runSession(payload, chunks, rand);
    assert.equal(cert.merkleRoot, reference, `mask=${mask}`);
    assert.equal(cert.receivedBytes, n);
  }
});
