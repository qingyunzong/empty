// End-to-end CLI: add / retract / solve --budget, exit codes 0/1/2/3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpDir, runCli, runCliStdin, writeJson } from '../testkit/helpers.js';

const E1 = { id: 'e1', device: 'd1', ts: 0, vc: { d1: 1 }, type: 'RUN' };
const E2 = { id: 'e2', device: 'd1', ts: 1, vc: { d1: 2 }, type: 'STOP' };
const E3 = { id: 'e3', device: 'd1', ts: 2, vc: { d1: 3 }, type: 'RUN' }; // illegal: needs RESET

test('CLI add (file and stdin), solve, retract round-trip', () => {
  const dir = tmpDir();
  const db = join(dir, 'db.json');

  // add via file
  const f1 = writeJson(dir, 'e1.json', JSON.stringify(E1));
  assert.equal(runCli(['add', f1, '--db', db]).status, 0);
  // add via stdin
  const resIn = runCliStdin(['add', '-', '--db', db], JSON.stringify(E2));
  assert.equal(resIn.status, 0);

  // solve: sat, exit 0
  const sat = runCli(['solve', '--budget', '1000', '--db', db]);
  assert.equal(sat.status, 0);
  const satResult = JSON.parse(sat.stdout);
  assert.equal(satResult.status, 'sat');
  assert.deepEqual(satResult.order, ['e1', 'e2']);

  // add erroneous event -> infeasible, exit 1, conflict chain present
  const f3 = writeJson(dir, 'e3.json', JSON.stringify(E3));
  assert.equal(runCli(['add', f3, '--db', db]).status, 0);
  const bad = runCli(['solve', '--budget', '1000', '--db', db]);
  assert.equal(bad.status, 1);
  const badResult = JSON.parse(bad.stdout);
  assert.equal(badResult.status, 'infeasible');
  assert.ok(badResult.conflict.events.includes('e3'));
  assert.deepEqual(badResult.conflict.rules, ['sequence:RUN:requires-ready']);

  // retract -> conflict gone, exit 0 again
  assert.equal(runCli(['retract', 'e3', '--db', db]).status, 0);
  const fixed = runCli(['solve', '--budget', '1000', '--db', db]);
  assert.equal(fixed.status, 0);
  assert.deepEqual(JSON.parse(fixed.stdout).order, ['e1', 'e2']);
});

test('CLI solve --budget 0 on concurrent histories exits 3 (unknown)', () => {
  const dir = tmpDir();
  const db = join(dir, 'db.json');
  const events = [
    { id: 'a1', device: 'd1', ts: 0, vc: { d1: 1 }, type: 'RUN' },
    { id: 'a2', device: 'd1', ts: 1, vc: { d1: 2 }, type: 'STOP' },
    { id: 'b1', device: 'd2', ts: 0, vc: { d2: 1 }, type: 'RUN' },
    { id: 'b2', device: 'd2', ts: 1, vc: { d2: 2 }, type: 'STOP' },
  ];
  for (const e of events) {
    const f = writeJson(dir, `${e.id}.json`, JSON.stringify(e));
    assert.equal(runCli(['add', f, '--db', db]).status, 0);
  }
  const res = runCli(['solve', '--budget', '0', '--db', db]);
  assert.equal(res.status, 3);
  const result = JSON.parse(res.stdout);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.pending, ['a1', 'a2', 'b1', 'b2']);
});
