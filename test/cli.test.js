import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../cli.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-cli-'));
  const run = (...args) => {
    const r = runCli(args, dir);
    return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  };
  return { dir, run };
}

test('CLI: nested batch correction flow end to end', () => {
  const { run } = setup();
  assert.match(run('begin').stdout, /tx 1/);
  run('set', 'station.temp', '20.5');
  assert.match(run('sub').stdout, /tx 2 \(child of 1\)/);
  run('set', 'station.temp', '21.1'); // corrected value
  run('set', 'station.wind', '3.4');
  assert.equal(run('get', 'station.temp').stdout, '21.1'); // read-your-writes
  run('commit'); // sub merges into root
  assert.match(run('commit').stdout, /committed/); // root hits WAL
  assert.equal(run('get', 'station.temp').stdout, '21.1');
  assert.equal(run('get', 'station.wind').stdout, '3.4');

  run('undo');
  assert.equal(run('get', 'station.temp').stdout, '(unset)');
  run('redo');
  assert.equal(run('get', 'station.temp').stdout, '21.1');

  const log = run('log').stdout;
  assert.match(log, /kind=normal/);
  assert.match(log, /kind=undo/);
  assert.match(log, /kind=redo/);
});

test('CLI: aborting a sub-batch keeps sibling corrections', () => {
  const { run } = setup();
  run('begin');
  run('set', 'a', '1');
  run('sub'); // tx 2
  run('set', 'b', '2');
  run('commit'); // merge tx2 into tx1
  run('sub'); // tx 3
  run('set', 'c', '3');
  run('abort'); // drop tx 3 only
  run('commit'); // root
  assert.equal(run('get', 'a').stdout, '1');
  assert.equal(run('get', 'b').stdout, '2');
  assert.equal(run('get', 'c').stdout, '(unset)');
});

test('CLI: error codes NOTHING_TO_UNDO and CLOSED', () => {
  const { run } = setup();
  const undo = run('undo');
  assert.equal(undo.code, 1);
  assert.match(undo.stderr, /NOTHING_TO_UNDO/);

  const abortNoTx = run('abort');
  assert.equal(abortNoTx.code, 1);
  assert.match(abortNoTx.stderr, /CLOSED/);

  run('begin');
  run('commit');
  const abortClosed = run('abort');
  assert.equal(abortClosed.code, 1);
  assert.match(abortClosed.stderr, /CLOSED/);
});

test('CLI: undo conflict with later write returns CONFLICT', () => {
  const { run } = setup();
  run('begin');
  run('set', 'k', '1');
  run('commit'); // tx 1
  run('begin');
  run('set', 'k', '2');
  run('commit'); // tx 2
  const conflict = run('undo', '1');
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /CONFLICT/);
  assert.equal(run('get', 'k').stdout, '2'); // unchanged
});
