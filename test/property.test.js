'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('../lib/gateway');
const { Framer } = require('../lib/framer');
const { mulberry32, frame, runStream, businessEvents, referenceEvents, genOps } = require('./helpers');

// Acceptance 4: random small streams (shuffled, duplicated, arbitrarily
// chunked) must yield exactly the reference enumeration, and the gateway
// digest must match a brute-force in-order replay.
test('property: shuffled/duplicated/chunked streams match reference and replay', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = mulberry32(seed);
    const ops = genOps(rand, 4 + Math.floor(rand() * 9)); // 4..12 ops
    const buffers = ops.map((op, i) => frame(i, op.type, op));

    // transport corruption: random permutation + random duplicates
    const wire = buffers.slice();
    for (let i = wire.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [wire[i], wire[j]] = [wire[j], wire[i]];
    }
    for (let d = 0; d < 3; d++) {
      wire.splice(Math.floor(rand() * (wire.length + 1)), 0, buffers[Math.floor(rand() * buffers.length)]);
    }

    // arbitrary chunking, down to half-frame splits
    const chunkSize = 1 + Math.floor(rand() * 7);
    const { events, gateway } = runStream(wire, { chunkSize, timeout: 1000, maxRetries: 5 });
    assert.equal(gateway.error, null, `seed ${seed}: unexpected gateway error`);

    const expected = referenceEvents(ops);
    assert.deepEqual(businessEvents(events), expected, `seed ${seed}: event order mismatch`);

    // brute-force replay: canonical order, no corruption
    const replay = new Gateway({ timeout: 1000, maxRetries: 5 });
    for (const buf of buffers) {
      const framer = new Framer();
      const frames = [...framer.push(buf), ...framer.end()];
      for (const f of frames) replay.ingest(f);
    }
    replay.finish();
    const cert = events[events.length - 1].certificate;
    assert.equal(cert.digest, replay.certificate().certificate.digest, `seed ${seed}: digest mismatch`);
    assert.equal(cert.delivered, ops.length, `seed ${seed}: delivered count`);
  }
});

test('property: duplicate-heavy streams never double-post', () => {
  const rand = mulberry32(0xc0ffee);
  const ops = genOps(rand, 10);
  const buffers = ops.map((op, i) => frame(i, op.type, op));
  const wire = [];
  for (const buf of buffers) {
    wire.push(buf, buf); // every frame twice
    if (rand() < 0.3) wire.push(buf);
  }
  const { events, gateway } = runStream(wire, { chunkSize: 3 });
  assert.equal(gateway.error, null);
  assert.deepEqual(businessEvents(events), referenceEvents(ops));
  const cert = events[events.length - 1].certificate;
  assert.equal(cert.delivered, ops.length);
  assert.equal(cert.duplicates, wire.length - ops.length);
});
