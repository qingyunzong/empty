'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');

function runCli(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weld-cli-'));
  const input = path.join(dir, 'mode-events.jsonl');
  fs.writeFileSync(input, lines.join('\n') + '\n');
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const res = spawnSync(process.execPath, [CLI, input, dir], {
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const read = (name) => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : null;
  };
  return {
    ...res,
    dir,
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    stderr: fs.readFileSync(stderrPath, 'utf8'),
    transitions: read('transition.jsonl'),
    violations: read('violations.jsonl'),
  };
}

test('exit 13 on unknown mode', () => {
  const res = runCli([
    JSON.stringify({ clock: 1, seq: 1, source: 'hmi', type: 'mode_request', mode: 'fly' }),
  ]);
  assert.equal(res.status, 13);
  assert.match(res.stderr, /unknown mode/);
});

test('exit 14 on non-monotonic clock', () => {
  const res = runCli([
    JSON.stringify({ clock: 2, seq: 1, source: 'door', type: 'door', state: 'open' }),
    JSON.stringify({ clock: 1, seq: 2, source: 'door', type: 'door', state: 'closed' }),
  ]);
  assert.equal(res.status, 14);
  assert.match(res.stderr, /non-monotonic clock/);
});

test('exit 15 on contradictory door sensor states at one clock', () => {
  const res = runCli([
    JSON.stringify({ clock: 1, seq: 1, source: 'door', type: 'door', state: 'open' }),
    JSON.stringify({ clock: 1, seq: 2, source: 'door', type: 'door', state: 'closed' }),
  ]);
  assert.equal(res.status, 15);
  assert.match(res.stderr, /contradictory door sensor/);
});

test('exit 0 on a valid log and both outputs are written', () => {
  const res = runCli([
    JSON.stringify({ clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'K1', level: 'team' }),
    JSON.stringify({ clock: 2, seq: 2, source: 'hmi', type: 'mode_request', mode: 'auto' }),
    JSON.stringify({ clock: 3, seq: 3, source: 'plc', type: 'auto_start' }),
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.transitions.length >= 3);
  assert.deepEqual(res.violations, []);
  const last = res.transitions.at(-1);
  assert.equal(last.transition, 'auto_started');
  assert.equal(last.state.running, true);
});

test('CLI counterexample search reports none for the safe interpreter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weld-cli-'));
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const res = spawnSync(process.execPath, [CLI, '--counterexample', '6'], {
    stdio: ['ignore', stdoutFd, 'ignore'],
  });
  fs.closeSync(stdoutFd);
  const stdout = fs.readFileSync(stdoutPath, 'utf8');
  assert.equal(res.status, 0, res.stderr);
  assert.match(stdout, /no illegal automatic start up to depth 6/);
});
