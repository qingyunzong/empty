import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

// Driven in-process via runCli (same code path as bin/pay.js) so the tests
// also work in restricted sandboxes that block child processes.
function run(args) {
  const { code, stdout, stderr } = runCli(args);
  return {
    status: code,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
    errJson: () => JSON.parse(stderr.trim().split('\n')[0]),
  };
}

function tmpfile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paycli-')), 'log.txt');
}

test('CLI: init / apply / state happy path with exact fractions', () => {
  const f = tmpfile();
  let r = run(['init', f, '--limit', '1000/1']);
  assert.equal(r.status, 0, r.stderr);

  r = run(['apply', f, '{"type":"freeze","tx":"t1","amt":"100/1"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json().state.available, '900/1');

  r = run(['apply', f, '{"type":"capture","tx":"t1","amt":"33.335"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json().state.debt, '1667/50'); // RHE -> 33.34

  r = run(['apply', f, '{"type":"void","tx":"t1"}']);
  assert.equal(r.status, 0, r.stderr);

  r = run(['state', f]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json().available, '48333/50');
  assert.equal(r.json().frozenTotal, '0/1');
});

test('CLI: error codes map to exit codes 1/2/3/4', () => {
  const f = tmpfile();
  run(['init', f, '--limit', '100/1']);

  let r = run(['apply', f, '{not json']);
  assert.equal(r.status, 1);
  assert.equal(r.errJson().error, 'E_PARSE');

  r = run(['apply', f, '{"type":"capture","tx":"ghost","amt":"1/1"}']);
  assert.equal(r.status, 2);
  assert.equal(r.errJson().error, 'E_REF');

  r = run(['apply', f, '{"type":"freeze","tx":"big","amt":"101/1"}']);
  assert.equal(r.status, 3);
  assert.equal(r.errJson().error, 'E_STATE');

  r = run(['state', path.join(os.tmpdir(), `no-such-${process.pid}.log`)]);
  assert.equal(r.status, 4);
  assert.equal(r.errJson().error, 'E_IO');

  // failed applies must not append anything
  r = run(['state', f]);
  assert.equal(r.json().available, '100/1');
});

test('CLI: crash injection -> startup truncates and prints recovery summary', () => {
  const f = tmpfile();
  run(['init', f, '--limit', '500/1']);
  run(['apply', f, '{"type":"freeze","tx":"t1","amt":"100/1"}']);
  run(['apply', f, '{"type":"capture","tx":"t1","amt":"40/1","id":"c1"}']);
  const before = run(['state', f]).json();

  // power loss: record written, checksum line missing
  fs.appendFileSync(f, JSON.stringify({ type: 'reverse', captureId: 'c1' }) + '\n');

  const r = run(['state', f]);
  assert.equal(r.status, 0, r.stderr);
  const recovery = r.errJson();
  assert.equal(recovery.recovered, true);
  assert.ok(recovery.droppedBytes > 0);
  assert.deepEqual(r.json(), before); // replay consistent

  // recover command reports a clean log afterwards
  const r2 = run(['recover', f]);
  assert.equal(r2.status, 0);
  assert.equal(r2.json().truncated, false);
});

test('CLI: replay prints a per-event trace consistent with final state', () => {
  const f = tmpfile();
  run(['init', f, '--limit', '100/1']);
  run(['apply', f, '{"type":"freeze","tx":"a","amt":"60/1"}']);
  run(['apply', f, '{"type":"capture","tx":"a","amt":"25/1","id":"k"}']);
  run(['apply', f, '{"type":"reverse","captureId":"k"}']);
  const r = run(['replay', f]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.equal(out.events, 3);
  assert.equal(out.trace.length, 3);
  assert.equal(out.trace.at(-1).available, '65/1'); // 100 - 35 frozen remainder, debt reversed
  assert.equal(out.state.available, '65/1');
});

test('CLI: merge conflict exits 3 and emits a verifiable counterexample', () => {
  const f = tmpfile();
  run(['init', f, '--limit', '100/1']);
  run(['apply', f, '{"type":"freeze","tx":"t1","amt":"80/1"}']);
  run(['apply', f, '{"type":"branch","name":"b1","fromEvent":1}']);
  run(['apply', f, '{"type":"capture","tx":"t1","amt":"70/1","id":"c-b1"}']);
  run(['apply', f, '{"type":"checkout","name":"main"}']);
  run(['apply', f, '{"type":"capture","tx":"t1","amt":"70/1","id":"c-main"}']);
  const r = run(['apply', f, '{"type":"merge","branch":"b1"}']);
  assert.equal(r.status, 3);
  const err = r.errJson();
  assert.equal(err.error, 'E_STATE');
  const cx = err.details.counterexample;
  assert.equal(cx.failingOp.id, 'c-b1');
  assert.equal(cx.stateBefore.frozen.t1, '10/1'); // 70 > 10 -> invariant violated
  // log untouched by the failed merge
  assert.equal(run(['state', f]).json().debt, '70/1');
});
