'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');
const { Journal } = require('../src/journal');

function runCli(args) {
  let out = '';
  let err = '';
  const code = run(args, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  return { code, out, err };
}

function tmpFile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'txn-undo-')), 'journal.jsonl');
  fs.writeFileSync(file, contents);
  return file;
}

test('CLI: replay prints state, balance, frozen amount and undo plan', () => {
  const journal = new Journal();
  journal.commit({ id: 'e1', op: 'open', account: 'a', balance: 100 });
  journal.commit({ id: 'e2', op: 'debit', account: 'a', amount: 30 });
  journal.commit({ id: 'e3', op: 'hold', account: 'a', amount: 20 });
  const { code, out } = runCli(['replay', tmpFile(journal.toJSONL())]);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.head, 'e3');
  assert.deepEqual(parsed.accounts.a, { state: 'OPEN', balance: 70, held: 20 });
  assert.deepEqual(parsed.undoPlan, [{ op: 'release', account: 'a', amount: 20, undoes: 'e3' }]);
});

test('CLI: replay --repair auto-repairs ERROR accounts and continues', () => {
  const lines = [
    JSON.stringify({ type: 'event', event: { id: 'e1', op: 'open', account: 'a', balance: 100 } }),
    JSON.stringify({ type: 'snapshot', state: { head: 'e1', accounts: { a: { state: 'OPEN', balance: 100, held: 0 } } } }),
    JSON.stringify({ type: 'head', event: 'e1' }),
    JSON.stringify({ type: 'event', event: { id: 'e2', op: 'debit', account: 'a', amount: 200 } }), // NEGATIVE -> ERROR
    JSON.stringify({ type: 'event', event: { id: 'e3', op: 'debit', account: 'a', amount: 10 } }), // needs repair first
    JSON.stringify({ type: 'head', event: 'e3' }),
  ].join('\n') + '\n';
  const { code, out } = runCli(['replay', tmpFile(lines), '--repair']);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.repairs, ['e2']);
  assert.deepEqual(parsed.accounts.a, { state: 'OPEN', balance: 90, held: 0 });
  assert.equal(parsed.head, 'e3');
});

test('CLI: corrupt journal exits non-zero with CORRUPT_JOURNAL', () => {
  const file = tmpFile('{"type":"event","event":{"id":"e1","op":"open","account":"a","balance":1}}\ngarbage\n{"type":"head","event":"e1"}\n');
  const { code, err } = runCli(['replay', file]);
  assert.equal(code, 1);
  assert.match(err, /CORRUPT_JOURNAL/);
});

test('CLI: raw JSONL event stream is accepted and --undo prints the plan', () => {
  const raw = [
    JSON.stringify({ id: 'e1', op: 'open', account: 'a', balance: 50 }),
    JSON.stringify({ id: 'e2', op: 'debit', account: 'a', amount: 20 }),
  ].join('\n') + '\n';
  const { code, out } = runCli(['replay', tmpFile(raw), '--undo', 'e2']);
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.accounts.a, { state: 'OPEN', balance: 30, held: 0 });
  assert.deepEqual(parsed.undoPlan, [{ op: 'credit', account: 'a', amount: 20, undoes: 'e2' }]);
});
