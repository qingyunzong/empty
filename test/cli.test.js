import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../src/cli.js';
import { verifyLog } from '../src/engine.js';

const OPS = [
  { clientOpId: 'd1', clock: 1, type: 'deposit', amount: 100 },
  { clientOpId: 'a1', clock: 2, type: 'authorize', amount: 60 },
  { clientOpId: 'c1', clock: 3, type: 'confirm', parent: 'a1' },
  { clientOpId: 'v1', clock: 4, type: 'void', parent: 'a1', amount: 25 },
];

test('CLI reads an op array from stdin and writes the account view, log and hash chain', () => {
  const { code, stdout, stderr } = execute(JSON.stringify(OPS));
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.view.available, 65);
  assert.equal(out.view.frozen, 35);
  assert.equal(out.results.length, 4);
  assert.ok(out.results.every((r) => r.status === 'APPLIED'));
  assert.equal(out.log.length, 4);
  assert.equal(verifyLog(out.log), true);
  assert.equal(out.log[out.log.length - 1].hash, out.head);
});

test('CLI accepts an {"ops":[...]} envelope and reports business errors per op', () => {
  const { code, stdout } = execute(JSON.stringify({ ops: [{ clientOpId: 'a1', clock: 1, type: 'authorize', amount: 10 }] }));
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.results[0].status, 'ERROR');
  assert.equal(out.results[0].error, 'INSUFFICIENT');
});

test('CLI fails atomically on malformed input and writes nothing to stdout or disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'));
  const statePath = join(dir, 'state.json');

  const badJson = execute('not json', ['--state', statePath]);
  assert.equal(badJson.code, 1);
  assert.equal(badJson.stdout, '');
  assert.equal(JSON.parse(badJson.stderr).ok, false);
  assert.equal(existsSync(statePath), false);

  const badOp = execute(JSON.stringify([{ clientOpId: 'x', clock: 1, type: 'authorize', amount: -3 }]), ['--state', statePath]);
  assert.equal(badOp.code, 1);
  assert.equal(badOp.stdout, '');
  assert.equal(existsSync(statePath), false);

  const badArgs = execute('[]', ['--bogus']);
  assert.equal(badArgs.code, 1);
  assert.equal(badArgs.stdout, '');
});

test('CLI persists submitted ops and replaying history yields the same final state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'));
  const statePath = join(dir, 'state.json');

  const first = execute(JSON.stringify(OPS.slice(0, 2)), ['--state', statePath]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).view.frozen, 60);

  const second = execute(JSON.stringify(OPS.slice(2)), ['--state', statePath]);
  assert.equal(second.code, 0, second.stderr);
  const secondOut = JSON.parse(second.stdout);
  assert.equal(secondOut.view.available, 65);
  assert.equal(secondOut.view.frozen, 35);

  const fresh = execute(JSON.stringify(OPS));
  assert.equal(fresh.code, 0, fresh.stderr);
  const freshOut = JSON.parse(fresh.stdout);
  assert.deepEqual(secondOut.view, freshOut.view);
  assert.equal(secondOut.head, freshOut.head);

  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(saved.submitted.length, 4);

  const failing = execute(JSON.stringify([{ clientOpId: 'bad', clock: -1, type: 'deposit', amount: 1 }]), ['--state', statePath]);
  assert.equal(failing.code, 1);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).submitted.length, 4);
});
