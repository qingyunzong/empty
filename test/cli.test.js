import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';

// NOTE: the sandbox blocks spawning nested node processes (EPERM), so the CLI
// is exercised through its pure `run(raw)` entry point; real-process exit
// codes 0/1/2 were verified manually via `node src/cli.js` (see RESULTS.md).

test('cli: full ack flow exits 0 with JSON results', () => {
  const { code, stdout, stderr } = run(JSON.stringify({
    ops: [
      { op: 'insert', deviceId: 'd1', alarmTime: 1 },
      { op: 'insert', deviceId: 'd1', alarmTime: 2 },
      { op: 'begin', txn: 't' },
      { op: 'ack', txn: 't', deviceId: 'd1', start: 0, end: 10, by: 'alice', at: '2026-10-04T00:00:00Z', note: 'batch' },
      { op: 'commit', txn: 't' },
      { op: 'list' },
      { op: 'records' },
    ],
  }));
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const out = JSON.parse(stdout);
  assert.equal(out.results.length, 7);
  assert.equal(out.results[3].count, 2);
  assert.equal(out.results[5].alarms.every((a) => a.state === 'acked'), true);
  assert.equal(out.results[6].records.length, 2);
  assert.equal(out.results[6].records[0].ackedBy, 'alice');
  assert.equal(out.results[6].records[0].note, 'batch');
});

test('cli: phantom conflict exits 1 with E_PHANTOM in results', () => {
  const { code, stdout } = run(JSON.stringify({
    ops: [
      { op: 'insert', deviceId: 'd1', alarmTime: 1 },
      { op: 'begin', txn: 'a' },
      { op: 'begin', txn: 'b' },
      { op: 'ack', txn: 'a', deviceId: 'd1', start: 0, end: 10, by: 'x' },
      { op: 'insert', txn: 'b', deviceId: 'd1', alarmTime: 5 },
      { op: 'commit', txn: 'a' },
      { op: 'commit', txn: 'b' },
    ],
  }));
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.results[5].ok, true);
  assert.equal(out.results[6].ok, false);
  assert.equal(out.results[6].error.code, 'E_PHANTOM');
});

test('cli: rollback leaves no records and exits 0', () => {
  const { code, stdout } = run(JSON.stringify({
    ops: [
      { op: 'insert', deviceId: 'd1', alarmTime: 1 },
      { op: 'begin', txn: 't' },
      { op: 'ack', txn: 't', deviceId: 'd1', start: 0, end: 10, by: 'x' },
      { op: 'rollback', txn: 't' },
      { op: 'list' },
      { op: 'records' },
    ],
  }));
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.results[4].alarms[0].state, 'unacked');
  assert.equal(out.results[5].records.length, 0);
});

test('cli: malformed input exits 2', () => {
  assert.equal(run('this is not json').code, 2);
  assert.equal(run(JSON.stringify({ noOps: true })).code, 2);
  assert.equal(run(JSON.stringify({ ops: [{ op: 'nope' }] })).code, 2);
  assert.equal(run(JSON.stringify({ ops: [{ op: 'commit', txn: 'ghost' }] })).code, 2);
  assert.equal(run(JSON.stringify({ ops: [{ op: 'begin', txn: 't' }, { op: 'ack', txn: 't', deviceId: 'd', start: 9, end: 1 }] })).code, 1);
});
