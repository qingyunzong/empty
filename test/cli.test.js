// CLI session tests run in-process via createSession(): the offline sandbox
// denies child_process spawning, and the JSON-lines handler is identical
// either way (src/cli.js only wires stdin/stdout to session.handle).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/cli.js';

test('CLI round-trip: addItem/audit/correct/bound/explain', () => {
  const session = createSession();
  const out = [
    { cmd: 'addItem', id: 'a', claimedNum: 100, claimedDen: 1 },
    { cmd: 'addItem', id: 'b', claimedNum: 40, claimedDen: 1 },
    { cmd: 'audit', id: 'a', actualNum: 90, actualDen: 1 },
    { cmd: 'bound', confidenceNum: 1, confidenceDen: 1 },
    { cmd: 'correct', id: 'a', newClaimed: '95/1' },
    { cmd: 'audit', id: 'b', actualNum: 41, actualDen: 1 },
    { cmd: 'bound', confidenceNum: 1, confidenceDen: 1 },
    { cmd: 'explain' },
  ].map((msg) => session.handle(JSON.stringify(msg)));

  assert.equal(out[0].ok, true);
  assert.equal(out[2].ok, true);
  // partial audit: pending, excludes b
  assert.equal(out[3].result.status, 'pending');
  assert.equal(out[3].result.code, 'E_PENDING');
  assert.equal(out[3].result.lower, '-10');
  assert.deepEqual(out[3].result.witnessIds, ['a']);
  // after correction + full audit: exact interval
  assert.equal(out[6].result.status, 'ok');
  assert.equal(out[6].result.lower, '-5');
  assert.equal(out[6].result.upper, '1');
  // explain certificate matches the current version (5 mutations so far)
  assert.equal(out[7].result.version, 5);
  assert.equal(out[7].result.strata.audited.lower, '-5');
  assert.equal(out[7].result.strata.unaudited.status, 'ok');
  // every result line is JSON-serializable (stdout contract)
  for (const line of out) assert.doesNotThrow(() => JSON.stringify(line));
});

test('CLI surfaces E_CONF, E_LAYER, E_CMD and E_PARSE', () => {
  const session = createSession();
  const out = [
    JSON.stringify({ cmd: 'bound', confidenceNum: 1, confidenceDen: 1 }),
    JSON.stringify({ cmd: 'addItem', id: 'a', claimedNum: 5 }),
    JSON.stringify({ cmd: 'audit', id: 'a', actualNum: 6 }),
    JSON.stringify({ cmd: 'bound', confidenceNum: 0, confidenceDen: 1 }),
    JSON.stringify({ cmd: 'frobnicate' }),
    'not json',
  ].map((line) => session.handle(line));
  assert.equal(out[0].ok, false);
  assert.equal(out[0].error.code, 'E_LAYER');
  assert.equal(out[3].error.code, 'E_CONF');
  assert.equal(out[4].error.code, 'E_CMD');
  assert.equal(out[5].error.code, 'E_PARSE');
});
