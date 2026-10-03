import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;

function tmpWal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-cli-'));
  return path.join(dir, 'events.wal');
}

// Note: this sandbox breaks spawnSync stdin pipes (no EOF), so JSON input is
// passed via --input here; the stdin path is covered by a bash-pipe test.
function runCli(args, input = undefined) {
  const fullArgs = [CLI, ...args];
  if (input !== undefined) fullArgs.push('--input', input);
  const res = spawnSync(process.execPath, fullArgs, { encoding: 'utf8', timeout: 30000 });
  const lines = (res.stdout ?? '').trim().split('\n').filter(Boolean);
  return {
    code: res.status,
    json: lines.length ? JSON.parse(lines[lines.length - 1]) : null,
    stderr: res.stderr,
    error: res.error,
  };
}

const events = [
  { eventId: 'e1', deviceId: 'dev-A', seq: 1, type: 'start' },
  { eventId: 'e2', deviceId: 'dev-A', seq: 2, type: 'count', value: 100 },
  { eventId: 'e3', deviceId: 'dev-A', seq: 3, type: 'stop' },
];

test('acceptance 1: append 3 events, restart, query by deviceId+seq, dup fails', () => {
  const wal = tmpWal();
  for (const [i, event] of events.entries()) {
    const res = runCli(['append', '--wal', wal], JSON.stringify(event));
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json, { ok: true, walSeq: i, eventId: event.eventId });
  }

  // "Restart": every CLI invocation is a fresh process that recovers on open.
  const exact = runCli(['query', '--wal', wal], JSON.stringify({ deviceId: 'dev-A', seq: 2 }));
  assert.equal(exact.code, 0);
  assert.deepEqual(exact.json, { ok: true, events: [events[1]] });

  const all = runCli(['query', '--wal', wal], JSON.stringify({ deviceId: 'dev-A' }));
  assert.deepEqual(all.json.events, events);

  const got = runCli(['get', '--wal', wal], JSON.stringify({ eventId: 'e3' }));
  assert.deepEqual(got.json, { ok: true, event: events[2] });

  const missing = runCli(['get', '--wal', wal], JSON.stringify({ eventId: 'ghost' }));
  assert.equal(missing.code, 3);
  assert.equal(missing.json.error, 'E_NOTFOUND');

  const dup = runCli(['append', '--wal', wal], JSON.stringify(events[0]));
  assert.equal(dup.code, 2);
  assert.equal(dup.json.error, 'E_DUP');
});

test('cli reads JSON events from stdin', () => {
  const wal = tmpWal();
  const res = spawnSync(
    'bash',
    ['-c', 'printf "%s" "$EVENT_JSON" | node "$CLI_PATH" append --wal "$WAL_PATH"'],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, EVENT_JSON: JSON.stringify(events[0]), CLI_PATH: CLI, WAL_PATH: wal },
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { ok: true, walSeq: 0, eventId: 'e1' });
});

test('acceptance 2: fault point after_data -> event not visible after recover', () => {
  const wal = tmpWal();
  assert.equal(runCli(['append', '--wal', wal], JSON.stringify(events[0])).code, 0);

  const crash = runCli(['crash', '--wal', wal, '--at', 'after_data'], JSON.stringify(events[1]));
  assert.equal(crash.code, 70);
  assert.deepEqual(crash.json, { ok: false, crashed: true, at: 'after_data' });

  const rec = runCli(['recover', '--wal', wal]);
  assert.equal(rec.code, 0);
  assert.equal(rec.json.ok, true);

  const got = runCli(['get', '--wal', wal], JSON.stringify({ eventId: 'e2' }));
  assert.equal(got.code, 3);
  assert.equal(got.json.error, 'E_NOTFOUND');

  // Lost eventId can be reused.
  const redo = runCli(['append', '--wal', wal], JSON.stringify(events[1]));
  assert.equal(redo.code, 0);
});

test('acceptance 2: fault point after_sync -> event not visible after recover', () => {
  const wal = tmpWal();
  assert.equal(runCli(['append', '--wal', wal], JSON.stringify(events[0])).code, 0);

  const crash = runCli(['crash', '--wal', wal, '--at', 'after_sync'], JSON.stringify(events[1]));
  assert.equal(crash.code, 70);

  assert.equal(runCli(['recover', '--wal', wal]).code, 0);
  const got = runCli(['get', '--wal', wal], JSON.stringify({ eventId: 'e2' }));
  assert.equal(got.code, 3);
  const q = runCli(['query', '--wal', wal], JSON.stringify({ deviceId: 'dev-A' }));
  assert.deepEqual(q.json.events, [events[0]]);
});

test('acceptance 2: fault point after_commit -> event IS visible after recover', () => {
  const wal = tmpWal();
  assert.equal(runCli(['append', '--wal', wal], JSON.stringify(events[0])).code, 0);

  const crash = runCli(['crash', '--wal', wal, '--at', 'after_commit'], JSON.stringify(events[1]));
  assert.equal(crash.code, 70);

  assert.equal(runCli(['recover', '--wal', wal]).code, 0);
  const got = runCli(['get', '--wal', wal], JSON.stringify({ eventId: 'e2' }));
  assert.equal(got.code, 0);
  assert.deepEqual(got.json.event, events[1]);
});

test('cli usage and validation errors are JSON with mapped exit codes', () => {
  const wal = tmpWal();
  const noCmd = runCli([]);
  assert.equal(noCmd.code, 4);
  assert.equal(noCmd.json.error, 'E_USAGE');

  const badJson = runCli(['append', '--wal', wal], '{not json');
  assert.equal(badJson.code, 4);

  const badEvent = runCli(['append', '--wal', wal], JSON.stringify({ deviceId: 'A' }));
  assert.equal(badEvent.code, 5);
  assert.equal(badEvent.json.error, 'E_VALIDATION');

  const badPoint = runCli(['crash', '--wal', wal, '--at', 'nowhere'], JSON.stringify(events[0]));
  assert.equal(badPoint.code, 4);
});
