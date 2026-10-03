import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cli-'));
}

// Drives the CLI in-process (the sandbox forbids child processes). Each call
// is a fresh "process": no state is shared between calls except the files.
function cli(args, dir) {
  const out = [];
  const err = [];
  const status = run([...args, '--dir', dir], {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

function queryScc(dir) {
  const res = cli(['query-scc'], dir);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

// Acceptance 1: normal commits, then query SCC.
test('acceptance 1: query SCC after normal commits', () => {
  const dir = tmpdir();
  for (const [from, to] of [
    ['A', 'B'],
    ['B', 'A'],
    ['B', 'C'],
    ['C', 'D'],
    ['D', 'C'],
  ]) {
    const res = cli(['add-edge', from, to], dir);
    assert.equal(res.status, 0, res.stderr);
  }
  const out = queryScc(dir);
  assert.deepEqual(out.components, [['A', 'B'], ['C', 'D']]);
  assert.equal(out.appliedCount, 5);
  const verify = cli(['verify-history'], dir);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /^OK /);
});

// Acceptance 2: crash before checkpoint -> restart keeps the event and
// executes it exactly once.
test('acceptance 2: crash before-checkpoint, restart replays event once', () => {
  const dir = tmpdir();
  assert.equal(cli(['add-edge', 'A', 'B'], dir).status, 0);
  const crash = cli(['add-edge', 'B', 'C', '--crash=before-checkpoint'], dir);
  assert.equal(crash.status, 3);
  assert.match(crash.stderr, /before-checkpoint/);

  // Log has the event, checkpoint does not cover it yet.
  const logLines = fs
    .readFileSync(path.join(dir, 'append-audit.log'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(logLines.length, 2);

  // Restart: recovery replays the un-checkpointed log record exactly once.
  const out = queryScc(dir);
  assert.equal(out.appliedCount, 2, 'event must be applied exactly once');
  assert.equal(out.logLength, 2);
  assert.equal(out.checkpointedSeq, 1, 'checkpoint still covers only the first event');
  assert.deepEqual(out.components, [['A'], ['B'], ['C']]);

  const verify = cli(['verify-history'], dir);
  assert.equal(verify.status, 0, verify.stderr);

  // A subsequent commit checkpoints everything; state stays consistent.
  assert.equal(cli(['add-edge', 'C', 'A'], dir).status, 0);
  const out2 = queryScc(dir);
  assert.equal(out2.appliedCount, 3);
  assert.deepEqual(out2.components, [['A', 'B', 'C']]);
  assert.equal(cli(['verify-history'], dir).status, 0);
});

// Acceptance 3: crash after checkpoint -> restart does not re-execute;
// tampering any single log byte makes verify-history fail.
test('acceptance 3: crash after-checkpoint, no duplicate; tamper detected', () => {
  const dir = tmpdir();
  assert.equal(cli(['add-edge', 'A', 'B'], dir).status, 0);
  const crash = cli(['add-edge', 'B', 'C', '--crash=after-checkpoint'], dir);
  assert.equal(crash.status, 3);
  assert.match(crash.stderr, /after-checkpoint/);

  // Restart: checkpoint already covers both events; nothing is re-executed.
  const out = queryScc(dir);
  assert.equal(out.appliedCount, 2, 'checkpointed events must not be re-executed');
  assert.equal(out.checkpointedSeq, 2);
  assert.deepEqual(out.components, [['A'], ['B'], ['C']]);

  const verify = cli(['verify-history'], dir);
  assert.equal(verify.status, 0, verify.stderr);

  // Tamper a single byte in the middle of the log.
  const logFile = path.join(dir, 'append-audit.log');
  const text = fs.readFileSync(logFile, 'utf8');
  const idx = Math.floor(text.length / 2);
  const ch = text[idx];
  const replacement = ch === 'X' ? 'Y' : 'X';
  fs.writeFileSync(logFile, text.slice(0, idx) + replacement + text.slice(idx + 1));

  const bad = cli(['verify-history'], dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /VERIFY FAILED/);
});

test('verify-history succeeds on an empty directory', () => {
  const dir = tmpdir();
  const res = cli(['verify-history'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /events=0/);
});
