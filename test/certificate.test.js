'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, verifyCertificate } = require('../src/engine');

const CONFIG = { threshold: 10 };
const STATE = {
  frames: [
    { id: 'f1', night: 'N1', instrument: 'camA', signal: 20 },
    { id: 'f2', night: 'N2', instrument: 'camA', signal: 4 },
  ],
  calibrations: { camA: { dark: 0, flat: 1 } },
};
const TXS = [
  { op: { type: 'setWeather', night: 'N2', status: 'blocked' }, budget: 10 },
  { op: { type: 'setCalibration', instrument: 'camA', dark: 3, flat: 2 }, budget: 10 },
  { op: { type: 'regroup', frameId: 'f2', night: 'N1' }, budget: 10 },
];

test('certificates are deterministic and verifiable', () => {
  const run = () => {
    const engine = new Engine(CONFIG, STATE);
    return TXS.map((tx) => engine.applyTransaction(tx));
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  for (const entry of a) {
    assert.ok(entry.ok);
    assert.match(entry.certificate, /^sha256:[0-9a-f]{64}$/);
    assert.ok(verifyCertificate(entry, entry.stateHash));
  }
  // Certificates chain to distinct states.
  assert.notEqual(a[0].certificate, a[1].certificate);
});

test('certificate verification detects tampering', () => {
  const engine = new Engine(CONFIG, STATE);
  const entry = engine.applyTransaction(TXS[0]);
  assert.ok(verifyCertificate(entry, entry.stateHash));

  const tamperedDiffs = { ...entry, diffs: [...entry.diffs, { node: 'frame:ghost', layer: 'frame', night: 'N9', frameId: 'ghost', from: null, to: 'usable' }] };
  assert.equal(verifyCertificate(tamperedDiffs, entry.stateHash), false);

  const tamperedQueue = { ...entry, queue: [] };
  assert.equal(verifyCertificate(tamperedQueue, entry.stateHash), false);

  assert.equal(verifyCertificate(entry, '0'.repeat(64)), false);
  assert.equal(verifyCertificate(null, entry.stateHash), false);
});
