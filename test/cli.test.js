import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../cli.js';

// Note: the sandbox used for development blocks child_process spawning, so
// the CLI is tested in-process through its pure runCli(argv, stdin) entry
// point. The process wrapper in cli.js maps the result verbatim onto
// stdout/stderr/exit code (verified by a manual smoke run).

function runCliIn(input, dir) {
  const dataDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
  const result = runCli(['--data-dir', dataDir], input);
  return { ...result, dataDir };
}

test('cli: happy path exits 0 with canonical JSON lines', () => {
  const { status, stdout, stderr } = runCliIn(JSON.stringify([
    { op: 'begin' },
    { op: 'put', tx: 'tx1', key: 'wo1', value: { timeSlot: 't1', workcenter: 'wc1' } },
    { op: 'commit', tx: 'tx1' },
    { op: 'begin' },
    { op: 'get', tx: 'tx2', key: 'wo1' },
    { op: 'abort', tx: 'tx2' },
  ]));
  assert.equal(status, 0);
  assert.equal(stderr, '');
  const lines = stdout.trim().split('\n');
  assert.deepEqual(lines, [
    '{"baseVersion":0,"ok":true,"tx":"tx1"}',
    '{"ok":true}',
    '{"ok":true,"version":1}',
    '{"baseVersion":1,"ok":true,"tx":"tx2"}',
    '{"ok":true,"value":{"timeSlot":"t1","workcenter":"wc1"}}',
    '{"ok":true}',
  ]);
});

test('cli: unique conflict exits 1 with {code,message} on stderr', () => {
  const { status, stdout, stderr } = runCliIn(JSON.stringify([
    { op: 'begin' },
    { op: 'begin' },
    { op: 'put', tx: 'tx1', key: 'a', value: { workcenter: 'wc1', timeSlot: 't1' } },
    { op: 'put', tx: 'tx2', key: 'b', value: { workcenter: 'wc1', timeSlot: 't1' } },
    { op: 'commit', tx: 'tx1' },
    { op: 'commit', tx: 'tx2' },
  ]));
  assert.equal(status, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.code, 'E_UNIQUE');
  assert.equal(typeof err.message, 'string');
  const results = stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(results[4], { ok: true, version: 1 });
  assert.equal(results[5].ok, false);
  assert.equal(results[5].code, 'E_UNIQUE');
});

test('cli: snapshot conflict exits 1', () => {
  const { status, stderr } = runCliIn(JSON.stringify([
    { op: 'begin' },
    { op: 'begin' },
    { op: 'put', tx: 'tx1', key: 'a', value: 'newer' },
    { op: 'commit', tx: 'tx1' },
    { op: 'put', tx: 'tx2', key: 'a', value: 'stale-overwrite' },
    { op: 'commit', tx: 'tx2' },
  ]));
  assert.equal(status, 1);
  assert.equal(JSON.parse(stderr).code, 'E_SNAPSHOT');
});

test('cli: usage errors exit 2', () => {
  for (const input of [
    'not json at all',
    JSON.stringify([{ op: 'bogus' }]),
    JSON.stringify([{ op: 'get', tx: 'tx1' }]), // missing key
    JSON.stringify([{ op: 'get', tx: 'ghost', key: 'k' }]), // unknown tx
    JSON.stringify([{ op: 'put', tx: 'tx1', key: 'k' }]), // missing value
  ]) {
    const { status, stderr } = runCliIn(input);
    assert.equal(status, 2, `input: ${input}`);
    const err = JSON.parse(stderr);
    assert.equal(err.code, 'E_USAGE');
    assert.equal(typeof err.message, 'string');
  }
});

test('cli: unknown argument exits 2', () => {
  const result = runCli(['--bogus'], '[]');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).code, 'E_USAGE');
});

test('cli: NDJSON input and empty key / zero-length work order', () => {
  const ndjson = [
    JSON.stringify({ op: 'begin' }),
    JSON.stringify({ op: 'put', tx: 'tx1', key: '', value: '' }),
    JSON.stringify({ op: 'commit', tx: 'tx1' }),
    JSON.stringify({ op: 'begin' }),
    JSON.stringify({ op: 'get', tx: 'tx2', key: '' }),
  ].join('\n');
  const { status, stdout } = runCliIn(ndjson);
  assert.equal(status, 0);
  const last = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.deepEqual(last, { ok: true, value: '' });
});

test('cli: state persists across invocations of the same data dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
  const first = runCliIn(JSON.stringify([
    { op: 'begin' },
    { op: 'put', tx: 'tx1', key: 'wo1', value: { workcenter: 'wc1', timeSlot: 't1' } },
    { op: 'commit', tx: 'tx1' },
  ]), dir);
  assert.equal(first.status, 0);
  const second = runCliIn(JSON.stringify([
    { op: 'begin' },
    { op: 'get', tx: 'tx1', key: 'wo1' },
  ]), dir);
  assert.equal(second.status, 0);
  assert.deepEqual(JSON.parse(second.stdout.trim().split('\n').at(-1)), {
    ok: true,
    value: { workcenter: 'wc1', timeSlot: 't1' },
  });
  // Unique index survives the restart too.
  const third = runCliIn(JSON.stringify([
    { op: 'begin' },
    { op: 'put', tx: 'tx1', key: 'wo2', value: { workcenter: 'wc1', timeSlot: 't1' } },
    { op: 'commit', tx: 'tx1' },
  ]), dir);
  assert.equal(third.status, 1);
  assert.equal(JSON.parse(third.stderr).code, 'E_UNIQUE');
});
