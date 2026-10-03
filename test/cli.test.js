import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';

// The CLI is a thin readline wrapper around createSession (see cli.js); the
// command surface is exercised here in-process.
function runSession(lines) {
  const session = createSession();
  return lines.map((line) => session.handleLine(line));
}

test('cli session: add, audit, bound, explain, correct', () => {
  const out = runSession([
    '{"cmd":"addItem","id":"a","claimedNum":3,"claimedDen":2}',
    '{"cmd":"addItem","id":"b","claimedNum":7,"claimedDen":4}',
    '{"cmd":"audit","id":"a","actualNum":1,"actualDen":1}',
    '{"cmd":"bound","confidenceNum":19,"confidenceDen":20}',
    '{"cmd":"audit","id":"b","actualNum":9,"actualDen":4}',
    '{"cmd":"bound","confidenceNum":19,"confidenceDen":20}',
    '{"cmd":"explain"}',
    '{"cmd":"correct","id":"a","newClaimed":"5/4"}',
    '{"cmd":"bound","confidenceNum":19,"confidenceDen":20}',
  ]);
  assert.equal(out.length, 9);
  assert.ok(out.every((r) => r.ok));

  const pending = out[3].result;
  assert.equal(pending.status, 'E_PENDING');
  assert.equal(pending.lower, '-1/2');
  assert.equal(pending.upper, '0/1');
  assert.deepEqual(pending.witnessIds, ['a']);

  const full = out[5].result;
  assert.equal(full.status, 'OK');
  assert.equal(full.lower, '-1/2');
  assert.equal(full.upper, '1/2');
  assert.deepEqual(full.witnessIds, ['a', 'b']);

  const cert = out[6].result;
  assert.equal(cert.layers.pending.length, 0);
  assert.ok(Array.isArray(cert.chain) && cert.chain.length === 4);

  const corrected = out[8].result;
  assert.equal(corrected.lower, '-1/4');
  assert.notEqual(corrected.head, full.head);
});

test('cli reports structured errors', () => {
  const out = runSession([
    '{"cmd":"bound","confidenceNum":1,"confidenceDen":2}',
    '{"cmd":"addItem","id":"a","claimedNum":1}',
    '{"cmd":"bound","confidenceNum":1,"confidenceDen":1}',
    '{"cmd":"frobnicate"}',
  ]);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].error.code, 'E_LAYER');
  assert.equal(out[1].ok, true);
  assert.equal(out[2].ok, false);
  assert.equal(out[2].error.code, 'E_CONF');
  assert.equal(out[3].ok, false);
  assert.equal(out[3].error.code, 'E_CMD');
});
