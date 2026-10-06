import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paycore-cli-'));

// In-process CLI invocation (sandbox forbids spawning child processes).
function run(args) {
  let stdout = '', stderr = '';
  const code = runCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
const json = (r) => JSON.parse(r.stdout);

test('cli: init -> apply -> state roundtrip', () => {
  const file = path.join(tmp(), 'log.txt');
  let r = run(['init', file, '--limit', '100/1']);
  assert.equal(r.code, 0);
  assert.deepEqual(json(r), { ok: true, limit: '100' });

  r = run(['apply', file, '{"op":"freeze","tx":"t1","amt":"1/3"}', '{"op":"capture","tx":"t1","amt":"1/6"}', '{"op":"void","tx":"t1"}']);
  assert.equal(r.code, 0);
  assert.equal(json(r).results[1].capId, 'c0');

  r = run(['state', file]);
  const state = json(r).state;
  assert.equal(state.frozen, '0');
  assert.equal(state.captured, '17/100');
  assert.equal(state.available, '9983/100');
  assert.match(r.stderr, /recovery: \{"intactRecords":4,"droppedRecords":0,"bytesRemoved":0\}/);
});

test('cli: crash injection then replay prints recovery summary and consistent state', () => {
  const file = path.join(tmp(), 'log.txt');
  run(['init', file, '--limit', '20']);
  run(['apply', file, '{"op":"freeze","tx":"a","amt":"7/2"}', '{"op":"capture","tx":"a","amt":"3/2"}']);
  const good = json(run(['state', file])).state;

  // power loss: record written, checksum line not written
  fs.appendFileSync(file, JSON.stringify({ op: 'freeze', tx: 'ghost', amt: '1' }) + '\n');

  const r = run(['replay', file]);
  assert.equal(r.code, 0);
  const out = json(r);
  assert.equal(out.recovery.droppedRecords, 1);
  assert.ok(out.recovery.bytesRemoved > 0);
  assert.deepEqual(out.state, good); // replay consistent with pre-crash state
  assert.match(r.stderr, /recovery: /);
});

test('cli: errors carry codes and non-zero exit', () => {
  const file = path.join(tmp(), 'log.txt');
  run(['init', file, '--limit', '10']);
  let r = run(['apply', file, '{"op":"void","tx":"nope"}']);
  assert.equal(r.code, 1);
  assert.equal(json(r).error.code, 'E_REF');
  r = run(['apply', file, 'not-json']);
  assert.equal(r.code, 1);
  assert.equal(json(r).error.code, 'E_PARSE');
  r = run(['apply', file, '{"op":"freeze","tx":"t","amt":"11"}']);
  assert.equal(json(r).error.code, 'E_STATE');
  r = run(['init', file, '--limit', '5']); // re-init non-empty store
  assert.equal(r.code, 1);
  assert.equal(json(r).error.code, 'E_IO');
});

test('cli: branch flow with merge conflict surfaces counterexample', () => {
  const file = path.join(tmp(), 'log.txt');
  run(['init', file, '--limit', '10']);
  run(['apply', file,
    '{"op":"freeze","tx":"t1","amt":"6"}',
    '{"op":"branch","fromEvent":1,"name":"b"}',
    '{"op":"void","tx":"t1"}',
    '{"op":"freeze","tx":"t2","amt":"9"}',
    '{"op":"use","branch":"main"}',
    '{"op":"freeze","tx":"t3","amt":"4"}',
  ]);
  const r = run(['apply', file, '{"op":"merge","branch":"b"}']);
  assert.equal(r.code, 1);
  const err = json(r).error;
  assert.equal(err.code, 'E_STATE');
  assert.equal(err.details.counterexample.event.tx, 't2');
  assert.equal(err.details.counterexample.stateBefore.frozen, '4');
});
