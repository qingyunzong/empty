import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process. Each runCli call opens a fresh Store over the same directory,
// which is equivalent to a separate process invocation (all state is on disk).

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtx-cli-'));
}

test('CLI: nested batch, undo/redo, log, get', () => {
  const dir = tmpdir();
  const run = (...args) => runCli(args, dir);

  const t1 = run('begin');
  assert.match(t1.out, /^tx\d+$/);
  run('set', 'station', 'alpha');
  run('sub');
  run('set', 'temp', '21.5');
  assert.equal(run('commit').out.startsWith('committed'), true); // sub merges into parent
  assert.equal(run('get', 'temp').out, '21.5');
  run('commit'); // outermost commit -> WAL
  assert.equal(run('get', 'station').out, 'alpha');

  run('undo');
  assert.equal(run('get', 'station').out, '(null)');
  assert.equal(run('get', 'temp').out, '(null)');
  run('redo');
  assert.equal(run('get', 'station').out, 'alpha');
  assert.equal(run('get', 'temp').out, '21.5');

  const log = run('log').out;
  assert.match(log, /undo-depth=1 redo-depth=0/);
  assert.match(log, /undoable tx\d+ writes=\[\["station","alpha"\],\["temp","21.5"\]\]/);
});

test('CLI: abort of a sub-batch keeps the rest', () => {
  const dir = tmpdir();
  const run = (...args) => runCli(args, dir);
  run('begin');
  run('set', 'a', '1');
  run('sub');
  run('set', 'b', '2');
  run('abort');
  assert.equal(run('get', 'b').out, '(null)');
  assert.equal(run('get', 'a').out, '1');
  run('commit');
  assert.equal(run('get', 'a').out, '1');
});

test('CLI: error conventions', () => {
  const dir = tmpdir();
  const run = (...args) => runCli(args, dir);

  const nothing = run('undo');
  assert.equal(nothing.code, 1);
  assert.match(nothing.err, /NOTHING_TO_UNDO/);

  const t = run('begin').out;
  run('commit');
  const closed = run('abort', t);
  assert.equal(closed.code, 1);
  assert.match(closed.err, /CLOSED/);
});
