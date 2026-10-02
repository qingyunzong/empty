import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRequest, runCliText } from '../src/cli.js';

// Note: the CLI is exercised in-process because this environment disallows
// spawning child processes; the `node src/cli.js < req.json` entry path is
// verified separately via the shell.

test('CLI processes a request document end to end', () => {
  const out = executeRequest({
    ops: [
      { op: 'addSensor', id: 'a', raw: 1, offset: 1, scale: 2 },
      { op: 'addSensor', id: 'b', raw: 0, offset: 0, scale: 3 },
      { op: 'addCalibration', id: 'b', base: 'a' },
      { op: 'addCalibration', id: 'b', base: 'a' },
      { op: 'addCalibration', id: 'a', base: 'b' },
      { op: 'getResult', id: 'b' },
      { op: 'undo' },
      { op: 'redo' },
      { op: 'snapshot' },
    ],
  });
  assert.equal(out.ok, true);
  const [addA, addB, cal, dup, cyc, getB, undo, redo, snap] = out.results;
  assert.equal(addA.ok, true);
  assert.equal(addB.ok, true);
  assert.equal(cal.ok, true);
  assert.equal(dup.error.code, 'E_TOPO');
  assert.equal(cyc.error.code, 'E_CYCLE');
  assert.equal(getB.result.value, 9);
  assert.equal(getB.result.confidence, 1);
  assert.equal(undo.ok, true);
  assert.equal(redo.ok, true);
  assert.equal(snap.snapshot.results.b.value, 9);
  assert.deepEqual(out.snapshot.certificate.ordering, ['a', 'b']);
  assert.match(out.snapshot.certificate.coefficientsHash, /^[0-9a-f]{64}$/);
  assert.match(out.snapshot.certificate.topologyHash, /^[0-9a-f]{64}$/);
});

test('CLI handles blocked chains and empty requests', () => {
  const blocked = executeRequest([
    { op: 'addSensor', id: 'x', raw: 1, offset: 0, scale: 1 },
    { op: 'addCalibration', id: 'x', base: 'missing' },
  ]);
  assert.equal(blocked.snapshot.results.x.blocked, true);
  assert.equal(blocked.snapshot.results.x.confidence, 0);
  assert.equal(blocked.snapshot.results.x.value, null);

  const empty = executeRequest({ ops: [] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.results, []);
  assert.deepEqual(empty.snapshot.results, {});
  assert.deepEqual(empty.snapshot.certificate.ordering, []);
});

test('CLI rejects malformed input and unknown operations', () => {
  const malformed = runCliText('not json');
  assert.equal(malformed.exitCode, 1);
  assert.equal(malformed.output.ok, false);
  assert.equal(malformed.output.error.code, 'E_INPUT');

  const out = executeRequest({ ops: [{ op: 'teleport' }, { nope: true }] });
  assert.equal(out.results[0].error.code, 'E_OP');
  assert.equal(out.results[1].error.code, 'E_OP');

  const valid = runCliText(JSON.stringify({ ops: [{ op: 'snapshot' }] }));
  assert.equal(valid.exitCode, 0);
  assert.equal(valid.output.ok, true);
});
