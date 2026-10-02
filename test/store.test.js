import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CRASH_EXIT_CODE, LOG_FILE, CHECKPOINT_FILE, verifyHistory } from '../src/store.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
}

let captureCounter = 0;
// This sandbox cannot capture child output via pipes, so redirect to files.
function run(dir, ...args) {
  const base = path.join(os.tmpdir(), `settle-cli-${process.pid}-${captureCounter}`);
  captureCounter += 1;
  const outFd = fs.openSync(`${base}.out`, 'w');
  const errFd = fs.openSync(`${base}.err`, 'w');
  const result = spawnSync(process.execPath, [CLI, ...args, `--dir=${dir}`], {
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(`${base}.out`, 'utf8');
  const stderr = fs.readFileSync(`${base}.err`, 'utf8');
  fs.unlinkSync(`${base}.out`);
  fs.unlinkSync(`${base}.err`);
  return { status: result.status, stdout, stderr };
}

function runOk(dir, ...args) {
  const result = run(dir, ...args);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  return result;
}

function logLines(dir) {
  const logPath = path.join(dir, LOG_FILE);
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

function readCheckpoint(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, CHECKPOINT_FILE), 'utf8'));
}

test('acceptance 1: normal commits then query-scc', () => {
  const dir = makeDir();
  runOk(dir, 'add-edge', 'a', 'b');
  runOk(dir, 'add-edge', 'b', 'a');
  runOk(dir, 'add-edge', 'b', 'c');
  runOk(dir, 'add-edge', 'c', 'd');
  runOk(dir, 'add-edge', 'd', 'c');

  const result = runOk(dir, 'query-scc');
  assert.deepEqual(JSON.parse(result.stdout), [['a', 'b'], ['c', 'd']]);

  runOk(dir, 'delete-edge', 'b', 'a');
  const after = runOk(dir, 'query-scc');
  assert.deepEqual(JSON.parse(after.stdout), [['a'], ['b'], ['c', 'd']]);

  runOk(dir, 'verify-history');
});

test('acceptance 2: crash before-checkpoint keeps event, executed exactly once', () => {
  const dir = makeDir();
  runOk(dir, 'add-edge', 'x', 'y');

  const crashed = run(dir, 'add-edge', 'y', 'z', '--crash=before-checkpoint');
  assert.equal(crashed.status, CRASH_EXIT_CODE);

  // Event was appended and flushed to the log, but no checkpoint covers it.
  assert.equal(logLines(dir).length, 2);
  const checkpointBefore = readCheckpoint(dir);
  assert.equal(checkpointBefore.lastSeq, 1);

  // Restart: recovery replays the un-checkpointed event.
  const result = runOk(dir, 'query-scc');
  assert.deepEqual(JSON.parse(result.stdout), [['x'], ['y'], ['z']]);
  assert.equal(readCheckpoint(dir).lastSeq, 2);

  // Event applied exactly once: log unchanged, repeated restarts are no-ops.
  assert.equal(logLines(dir).length, 2);
  runOk(dir, 'query-scc');
  assert.equal(logLines(dir).length, 2);
  assert.equal(readCheckpoint(dir).lastSeq, 2);

  runOk(dir, 'verify-history');
});

test('acceptance 3: crash after-checkpoint does not duplicate; tampering is detected', () => {
  const dir = makeDir();
  runOk(dir, 'add-edge', 'p', 'q');

  const crashed = run(dir, 'add-edge', 'q', 'p', '--crash=after-checkpoint');
  assert.equal(crashed.status, CRASH_EXIT_CODE);

  // Checkpoint already covers the event.
  assert.equal(readCheckpoint(dir).lastSeq, 2);
  assert.equal(logLines(dir).length, 2);

  // Restart: nothing to replay, no duplicate execution.
  const result = runOk(dir, 'query-scc');
  assert.deepEqual(JSON.parse(result.stdout), [['p', 'q']]);
  assert.equal(logLines(dir).length, 2);
  assert.equal(readCheckpoint(dir).lastSeq, 2);
  runOk(dir, 'verify-history');

  // Tamper with a single byte of the log: verify-history must fail.
  const logPath = path.join(dir, LOG_FILE);
  const bytes = fs.readFileSync(logPath);
  const flipAt = bytes.findIndex((b) => b >= 0x30 && b <= 0x39); // flip a digit
  assert.notEqual(flipAt, -1);
  bytes[flipAt] = bytes[flipAt] === 0x30 ? 0x31 : 0x30;
  fs.writeFileSync(logPath, bytes);

  const tampered = run(dir, 'verify-history');
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /FAIL:/);
});

test('tampering any single byte of the log is detected', () => {
  const dir = makeDir();
  runOk(dir, 'add-edge', 'a', 'b');
  runOk(dir, 'add-edge', 'b', 'c');
  runOk(dir, 'delete-edge', 'a', 'b');

  const logPath = path.join(dir, LOG_FILE);
  const original = fs.readFileSync(logPath);
  for (let i = 0; i < original.length; i += 1) {
    const mutated = Buffer.from(original);
    mutated[i] = original[i] === 0x41 ? 0x42 : 0x41;
    fs.writeFileSync(logPath, mutated);
    let detected = false;
    try {
      detected = verifyHistory(dir).length > 0;
    } catch {
      detected = true; // e.g. corrupted JSON framing
    }
    assert.ok(detected, `byte ${i} tamper not detected`);
  }
  fs.writeFileSync(logPath, original);
  assert.deepEqual(verifyHistory(dir), []);
});

test('verify-history passes on empty and fresh stores', () => {
  const dir = makeDir();
  runOk(dir, 'verify-history');
  runOk(dir, 'add-edge', 'm', 'n');
  runOk(dir, 'verify-history');
});
