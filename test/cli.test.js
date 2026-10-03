import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, lines } from '../testutil/helpers.mjs';

const BASE_EVENTS = [
  { type: 'add_institution', id: 'A' },
  { type: 'add_institution', id: 'B' },
  { type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 },
  { type: 'commit' },
  { type: 'revoke', id: 'i1' },
];

test('CLI prints nets and certificate after every event', () => {
  const res = runCli(lines(BASE_EVENTS));
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(out.length, BASE_EVENTS.length);
  assert.deepEqual(out[2].nets, { A: -100, B: 100 });
  assert.equal(out[3].batch, 1);
  assert.deepEqual(out[4].nets, { A: 0, B: 0 });
  for (const line of out) assert.match(line.certificate, /^[0-9a-f]{64}$/);
});

test('CLI output is deterministic across runs', () => {
  const a = runCli(lines(BASE_EVENTS));
  const b = runCli(lines(BASE_EVENTS));
  assert.equal(a.stdout, b.stdout);
});

test('CLI rejects dependency cycles with exit code 2 and stderr error', () => {
  const events = [
    { type: 'add_institution', id: 'A' },
    { type: 'add_institution', id: 'B' },
    { type: 'depends', from: 'A', to: 'B' },
    { type: 'depends', from: 'B', to: 'A' },
  ];
  const res = runCli(lines(events));
  assert.equal(res.status, 2);
  const err = JSON.parse(res.stderr.trim());
  assert.equal(err.code, 'CYCLE');
  // Events before the failing one were still emitted on stdout.
  assert.equal(res.stdout.trim().split('\n').length, 3);
});

test('CLI reports invalid JSON and overflow with exit code 2', () => {
  const badJson = runCli('{"type":"add_institution","id":"A"}\nnot-json\n');
  assert.equal(badJson.status, 2);
  assert.equal(JSON.parse(badJson.stderr.trim()).code, 'BAD_JSON');

  const MAX = Number.MAX_SAFE_INTEGER;
  const overflow = runCli(
    lines([
      { type: 'add_institution', id: 'A' },
      { type: 'add_institution', id: 'B' },
      { type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: MAX },
      { type: 'submit', id: 'i2', version: 1, from: 'A', to: 'B', amount: 1 },
    ])
  );
  assert.equal(overflow.status, 2);
  assert.equal(JSON.parse(overflow.stderr.trim()).code, 'OVERFLOW');
});
