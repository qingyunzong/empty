import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.js';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Child stdout/stderr go through files (pipes to grandchildren are
// unreliable in some sandboxed environments).
function run(dir, args, env = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outPath = path.join(dir, `.out-${stamp}`);
  const errPath = path.join(dir, `.err-${stamp}`);
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [CLI, '--db', dir, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  res.stdout = fs.readFileSync(outPath, 'utf8');
  res.stderr = fs.readFileSync(errPath, 'utf8');
  fs.unlinkSync(outPath);
  fs.unlinkSync(errPath);
  return res;
}

function runJson(dir, args, env = {}) {
  const res = run(dir, args, env);
  assert.equal(res.signal, null, `cli killed: ${res.stderr}`);
  assert.equal(res.status, 0, `cli failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function seed(dir) {
  runJson(dir, ['add-lot', '--id', 'R', '--kind', 'raw', '--qty', '100', '--failed']);
  runJson(dir, ['add-lot', '--id', 'W', '--kind', 'wip', '--qty', '100']);
  runJson(dir, ['add-lot', '--id', 'F', '--kind', 'finished', '--qty', '50']);
  runJson(dir, ['add-edge', '--id', 'E1', '--from', 'R', '--to', 'W', '--kind', 'consume', '--qty', '60']);
  runJson(dir, ['add-edge', '--id', 'E2', '--from', 'W', '--to', 'F', '--kind', 'split', '--qty', '50']);
}

// Acceptance 4: kill -9 at the defined failure point (segment written,
// index not yet written). After restart the killed transaction must be
// fully invisible and every subsequent read deterministic.
test('kill -9 after segment write: transaction invisible, restart deterministic', () => {
  const dir = tmpdir('trace-crash-');
  seed(dir);
  const before = runJson(dir, ['snapshot']);

  // Crash mid-commit of a correct(E2) transaction.
  const crashed = run(dir, ['correct', '--edge', 'E2', '--qty', '10'], {
    TRACE_CRASH_POINT: 'after_segment',
  });
  assert.equal(crashed.signal, 'SIGKILL', `expected SIGKILL, got status=${crashed.status} signal=${crashed.signal}`);

  // Restart twice: recovery must be deterministic.
  const after1 = runJson(dir, ['snapshot']);
  const after2 = runJson(dir, ['snapshot']);
  assert.deepEqual(after1, after2, 'recovery is not deterministic');
  assert.deepEqual(after1, before, 'killed transaction must be fully invisible');
  assert.equal(after1.edges.find((e) => e.id === 'E2').qty, 50);

  // Committed transactions before the crash survive.
  assert.equal(after1.lots.length, 3);
  assert.equal(after1.edges.length, 2);

  // Impact results identical across restarts.
  const i1 = runJson(dir, ['impact', '--lot', 'R']);
  const i2 = runJson(dir, ['impact', '--lot', 'R']);
  assert.deepEqual(i1, i2);
  assert.deepEqual(i1.groups.finished, ['F']);

  // A repeated crash at the same point converges to the same state.
  const crashedAgain = run(dir, ['correct', '--edge', 'E2', '--qty', '10'], {
    TRACE_CRASH_POINT: 'after_segment',
  });
  assert.equal(crashedAgain.signal, 'SIGKILL');
  const after3 = runJson(dir, ['snapshot']);
  assert.deepEqual(after3, before, 'repeated crash must converge to the same state');
});

test('undo/redo journal survives kill -9 and restart', () => {
  const dir = tmpdir('trace-crash-undo-');
  seed(dir);

  // A committed undo survives restart.
  const undo = runJson(dir, ['undo']);
  assert.equal(undo.undone, true);
  let snap = runJson(dir, ['snapshot']);
  assert.equal(snap.edges.length, 1, 'undo must remove the last committed edge');
  assert.equal(snap.redoDepth, 1);

  // Crash in the middle of a redo: the redo must be invisible after restart.
  const crashed = run(dir, ['redo'], { TRACE_CRASH_POINT: 'after_segment' });
  assert.equal(crashed.signal, 'SIGKILL');
  snap = runJson(dir, ['snapshot']);
  assert.equal(snap.edges.length, 1, 'crashed redo must be invisible');
  assert.equal(snap.redoDepth, 1);

  // The same redo, committed cleanly, restores the edge.
  const redo = runJson(dir, ['redo']);
  assert.equal(redo.redone, true);
  snap = runJson(dir, ['snapshot']);
  assert.equal(snap.edges.length, 2);

  // Crash in the middle of an undo: invisible after restart, state intact.
  const crashedUndo = run(dir, ['undo'], { TRACE_CRASH_POINT: 'after_segment' });
  assert.equal(crashedUndo.signal, 'SIGKILL');
  const snap1 = runJson(dir, ['snapshot']);
  const snap2 = runJson(dir, ['snapshot']);
  assert.deepEqual(snap1, snap2);
  assert.equal(snap1.edges.length, 2, 'crashed undo must be invisible');
});
