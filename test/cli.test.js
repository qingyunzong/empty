import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walstore-cli-'));
}

function run(dir, args) {
  return runCli(['--data', dir, ...args]);
}

function runOk(dir, args) {
  const result = run(dir, args);
  assert.equal(result.code, 0, `expected success, got ${result.code}: ${result.stderr}`);
  return result.stdout.trim();
}

test('CLI apply/replay/checkpoint/audit happy path', () => {
  const dir = tmpdir();
  const record = JSON.parse(runOk(dir, ['apply', '--device', 'dev1', '--key', 'temp', '--value', '21.5']));
  assert.deepEqual(record, {
    seq: 1, txn: 1, op: 'set', device: 'dev1', key: 'temp', oldValue: null, newValue: 21.5,
  });
  runOk(dir, ['apply', '--device', 'dev1', '--key', 'temp', '--value', '22']);
  const replayed = JSON.parse(runOk(dir, ['replay', '--to', '1']));
  assert.deepEqual(replayed, { seq: 1, state: { dev1: { temp: 21.5 } } });
  assert.deepEqual(JSON.parse(runOk(dir, ['checkpoint'])), { seq: 2 });
  assert.match(runOk(dir, ['audit']), /^OK/);
});

test('CLI replay to a nonexistent sequence exits with NO_SUCH_TXN', () => {
  const dir = tmpdir();
  runOk(dir, ['apply', '--device', 'd', '--key', 'k', '--value', '1']);
  const result = run(dir, ['replay', '--to', '42']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /NO_SUCH_TXN/);
});

test('acceptance 3: truncated crash mid-log recovers, discards the tail, checkpoint continues', () => {
  const dir = tmpdir();
  // 50 committed changes through the real apply path.
  const store = new Store(dir).open();
  const model = new Map();
  for (let i = 1; i <= 50; i++) {
    store.apply({ device: `dev-${i % 5}`, key: `k${i}`, value: i });
    model.set(`k${i}`, i);
  }
  store.close();

  // Inject a crash: truncate the WAL in the middle of the log.
  const walPath = path.join(dir, 'wal.log');
  const size = fs.statSync(walPath).size;
  const mid = Math.floor(size / 2);
  assert.match(runOk(dir, ['inject', '--truncate-at', String(mid)]), /truncated/);

  // After restart: everything before the truncation point replays, the torn
  // tail is cleanly discarded.
  const replayed = JSON.parse(runOk(dir, ['replay']));
  assert.ok(replayed.seq > 0 && replayed.seq < 50, `unexpected seq ${replayed.seq}`);
  const surviving = new Store(dir).open();
  assert.equal(surviving.records.length, replayed.seq);
  for (let i = 1; i <= replayed.seq; i++) {
    assert.equal(replayed.state[`dev-${i % 5}`][`k${i}`], i);
  }
  assert.deepEqual(surviving.audit(), []);
  surviving.close();

  // The log is not contiguous beyond the truncation point: replaying past
  // the surviving records is a clean NO_SUCH_TXN, not corruption.
  const beyond = run(dir, ['replay', '--to', '50']);
  assert.equal(beyond.code, 1);
  assert.match(beyond.stderr, /NO_SUCH_TXN/);

  // Checkpoint and new changes continue from the recovered sequence.
  assert.deepEqual(JSON.parse(runOk(dir, ['checkpoint'])), { seq: replayed.seq });
  const next = JSON.parse(runOk(dir, ['apply', '--device', 'dev-0', '--key', 'resumed', '--value', '1']));
  assert.equal(next.seq, replayed.seq + 1);
  assert.match(runOk(dir, ['audit']), /^OK/);
  const finalState = JSON.parse(runOk(dir, ['replay']));
  assert.equal(finalState.seq, replayed.seq + 1);
  assert.equal(finalState.state['dev-0'].resumed, 1);
});

test('crash after write and after fsync both recover consistently', () => {
  for (const point of ['write', 'fsync']) {
    const dir = tmpdir();
    runOk(dir, ['apply', '--device', 'd', '--key', 'before', '--value', '1']);
    const crashed = run(dir, ['apply', '--device', 'd', '--key', 'crashed', '--value', '2', '--crash-after', point]);
    assert.equal(crashed.code, 2);
    assert.match(crashed.stderr, /CRASH simulated/);
    // The record was already written to the WAL at both crash points, so
    // recovery replays it and the derived index is rebuilt consistently.
    const replayed = JSON.parse(runOk(dir, ['replay']));
    assert.deepEqual(replayed.state, { d: { before: 1, crashed: 2 } });
    assert.match(runOk(dir, ['audit']), /^OK/);
    assert.deepEqual(JSON.parse(runOk(dir, ['checkpoint'])), { seq: 2 });
  }
});

test('CLI inject --corrupt-index makes audit report divergence', () => {
  const dir = tmpdir();
  runOk(dir, ['apply', '--device', 'dev1', '--key', 'temp', '--value', '21.5']);
  assert.match(runOk(dir, ['audit']), /^OK/);
  assert.match(runOk(dir, ['inject', '--corrupt-index']), /corrupted/);
  const audit = run(dir, ['audit']);
  assert.equal(audit.code, 1);
  assert.match(audit.stdout, /DIVERGENCE/);
  assert.match(audit.stdout, /phantom-key/);
  // Replay (source of truth) is unaffected.
  const replayed = JSON.parse(runOk(dir, ['replay']));
  assert.deepEqual(replayed.state, { dev1: { temp: 21.5 } });
});

test('CLI usage errors are reported with the USAGE code', () => {
  const dir = tmpdir();
  const result = run(dir, ['apply', '--device', 'd']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /USAGE/);
});
