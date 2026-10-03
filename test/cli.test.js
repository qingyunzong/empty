'use strict';

// CLI session tests. The sandbox forbids spawning child processes, so these
// drive the same runSession() core the CLI entrypoint uses; the exit code
// contract (0/1/2) is asserted on the returned value.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSession } = require('../src/cli');
const { Store } = require('../src/store');

function run(lines) {
  const store = new Store();
  const input = Array.isArray(lines) ? lines.join('\n') : lines;
  return runSession(store, input);
}

test('confirm flow: 3 alarms confirmed, re-confirm is 0, exit 0', () => {
  const { exitCode, results } = run([
    '{"op":"insert","id":"a1","deviceId":"d1","alarmTime":5}',
    '{"op":"insert","id":"a2","deviceId":"d1","alarmTime":10}',
    '{"op":"insert","id":"a3","deviceId":"d1","alarmTime":15}',
    '{"op":"confirm","deviceId":"d1","from":0,"to":20,"by":"op1","at":100,"note":"batch"}',
    '{"op":"confirm","deviceId":"d1","from":0,"to":20,"by":"op1","at":101}',
    '{"op":"dump"}',
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(results[3], { ok: true, count: 3 });
  assert.deepEqual(results[4], { ok: true, count: 0 });
  const dump = results[5];
  assert.equal(dump.ok, true);
  assert.equal(dump.alarms.length, 3);
  assert.ok(dump.alarms.every((a) => a.state === 'acked'));
  assert.equal(dump.acks.length, 3);
  assert.ok(dump.acks.every((a) => a.by === 'op1' && a.at === 100 && a.note === 'batch'));
});

test('phantom conflict: concurrent insert aborts confirmer, exit 1', () => {
  const { exitCode, results } = run([
    '{"op":"insert","id":"a1","deviceId":"d1","alarmTime":5}',
    '{"op":"begin","tx":"t1"}',
    '{"op":"confirm","tx":"t1","deviceId":"d1","from":0,"to":20,"by":"op1","at":100}',
    '{"op":"begin","tx":"t2"}',
    '{"op":"insert","tx":"t2","id":"a2","deviceId":"d1","alarmTime":9}',
    '{"op":"commit","tx":"t2"}',
    '{"op":"commit","tx":"t1"}',
    '{"op":"dump"}',
  ]);
  assert.equal(exitCode, 1);
  assert.deepEqual(results[2], { ok: true, count: 1 });
  assert.equal(results[6].ok, false);
  assert.equal(results[6].error, 'E_PHANTOM');
  const dump = results[7];
  assert.equal(dump.alarms.length, 2);
  assert.ok(dump.alarms.every((a) => a.state === 'unacked'));
  assert.equal(dump.acks.length, 0);
});

test('empty window confirm is a legal no-op with count 0', () => {
  const { exitCode, results } = run([
    '{"op":"insert","id":"a1","deviceId":"d1","alarmTime":5}',
    '{"op":"confirm","deviceId":"d1","from":100,"to":200,"by":"op1","at":100}',
    '{"op":"dump"}',
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(results[1], { ok: true, count: 0 });
  assert.equal(results[2].alarms[0].state, 'unacked');
  assert.equal(results[2].acks.length, 0);
});

test('duplicate id and bad input are domain errors, exit 1', () => {
  const { exitCode, results } = run([
    '{"op":"insert","id":"a1","deviceId":"d1","alarmTime":5}',
    '{"op":"insert","id":"a1","deviceId":"d1","alarmTime":6}',
  ]);
  assert.equal(exitCode, 1);
  assert.equal(results[1].error, 'E_DUP_ID');
});

test('invalid JSON and unknown op are structural errors, exit 2', () => {
  const { exitCode, results } = run(['not json', '{"op":"bogus"}']);
  assert.equal(exitCode, 2);
  assert.equal(results[0].error, 'E_PARSE');
  assert.equal(results[1].error, 'E_USAGE');
});

test('open transactions at EOF are rolled back, nothing persists', () => {
  const store = new Store();
  const { exitCode, results } = runSession(store, [
    '{"op":"begin","tx":"t1"}',
    '{"op":"insert","tx":"t1","id":"a1","deviceId":"d1","alarmTime":5}',
    '{"op":"dump"}',
  ].join('\n'));
  assert.equal(exitCode, 0);
  assert.equal(results[2].alarms.length, 0);
  assert.deepEqual(store.listAlarms(), []);
  assert.deepEqual(store.listAcks(), []);
});

test('rollback discards uncommitted inserts and acks', () => {
  const store = new Store();
  const { exitCode, results } = runSession(store, [
    '{"op":"insert","id":"a1","deviceId":"d1","alarmTime":5}',
    '{"op":"begin","tx":"t1"}',
    '{"op":"confirm","tx":"t1","deviceId":"d1","from":0,"to":20,"by":"op1","at":100}',
    '{"op":"rollback","tx":"t1"}',
    '{"op":"dump"}',
  ].join('\n'));
  assert.equal(exitCode, 0);
  const dump = results[4];
  assert.equal(dump.alarms[0].state, 'unacked');
  assert.equal(dump.acks.length, 0);
});
