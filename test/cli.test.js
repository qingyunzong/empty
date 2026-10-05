'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli.js');

function runCli(opsText, args = []) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-')), 'ops.jsonl');
  fs.writeFileSync(file, opsText);
  const lines = [];
  const errors = [];
  const code = run(['exec', file, ...args], { log: (l) => lines.push(l), error: (e) => errors.push(e) });
  return { code, rows: lines.map((line) => JSON.parse(line)), errors };
}

test('CLI exec processes JSONL and reports state + undoPlan per step', () => {
  const { code, rows } = runCli(
    [
      '{"op":"batchBegin","id":"b1"}',
      '{"op":"deposit","account":"alice","amount":200}',
      '{"op":"transfer","from":"alice","to":"bob","amount":50}',
      '{"op":"freeze","account":"alice","amount":30}',
      '{"op":"batchEnd","id":"b1"}',
      '{"op":"undo"}',
      'not json',
    ].join('\n'),
    ['--budget', 'day=1000']
  );
  assert.equal(code, 0);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].step, 1);
  assert.equal(rows[4].status, 'ok');
  assert.deepEqual(rows[4].state.accounts.alice, { balance: 150, frozen: 30 });
  assert.equal(rows[4].state.budget.day, 750);
  assert.equal(rows[4].undoDepth, 1);
  assert.equal(rows[5].input.op, 'undo');
  if (rows[5].status === 'ok') {
    assert.ok(rows[5].undoPlan.steps.length > 0);
    assert.deepEqual(rows[5].state.accounts, {});
    assert.equal(rows[5].state.budget.day, 1000);
  } else {
    assert.equal(rows[5].error.code, 'AMBIGUOUS_UNDO');
    assert.ok(rows[5].undoPlan.candidates.length > 1);
  }
  assert.equal(rows[6].status, 'error');
  assert.equal(rows[6].error.code, 'INVALID');
});

test('CLI reports INSUFFICIENT and keeps going', () => {
  const { rows } = runCli(
    [
      '{"op":"deposit","account":"a","amount":10}',
      '{"op":"withdraw","account":"a","amount":50}',
      '{"op":"undo"}',
    ].join('\n')
  );
  assert.equal(rows[1].error.code, 'INSUFFICIENT');
  assert.equal(rows[2].status, 'ok');
  assert.deepEqual(rows[2].state.accounts, {});
});

test('CLI exits non-zero on missing file or bad args', () => {
  const sink = { log: () => {}, error: () => {} };
  assert.equal(run(['exec', '/no/such/file'], sink), 1);
  assert.equal(run([], sink), 1);
  assert.equal(run(['exec'], sink), 1);
});
