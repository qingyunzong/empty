import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, exitCodeFor } from '../cli.js';

function run(args, dir) {
  const json = execute([...args, '--dir', dir]);
  return { code: exitCodeFor(json), json };
}

test('CLI end-to-end: exit codes 0/1/2 and JSON results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txcli-'));

  // put -> 0
  let r = run(['put', '--tx', 'T1', '--price', '100', '--qty', '5', '--author', 'alice'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  const base = r.json.head;

  // replace -> 0
  r = run(['replace', '--tx', 'T1', '--price', '101', '--author', 'bob'], dir);
  assert.equal(r.code, 0);

  // materialize -> 0, margin freeze recomputed
  r = run(['materialize', '--tx', 'T1'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.price, 101);
  assert.equal(r.json.frozen, 50.5);

  // unknown tx -> 1
  r = run(['materialize', '--tx', 'NOPE'], dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.error, 'TX_NOT_FOUND');

  // same-field conflict -> 2 (two concurrent replaces of price on one parent)
  r = run(['replace', '--tx', 'T1', '--price', '102', '--author', 'c'], dir);
  assert.equal(r.code, 0);
  const linear = r.json.head;
  r = run(['replace', '--tx', 'T1', '--price', '103', '--author', 'd', '--base', linear], dir);
  assert.equal(r.code, 0);
  r = run(['replace', '--tx', 'T1', '--price', '104', '--author', 'e', '--base', linear], dir);
  assert.equal(r.code, 2);
  assert.equal(r.json.status, 'CONFLICT');
  assert.equal(r.json.heads.length, 2);

  // history shows parallel heads
  r = run(['history', '--tx', 'T1'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.heads.length, 2);

  // resolve -> 0
  r = run(['resolve', '--tx', 'T1', '--price', '104', '--author', 'f'], dir);
  assert.equal(r.code, 0);
  r = run(['materialize', '--tx', 'T1'], dir);
  assert.equal(r.json.price, 104);

  // cancel -> 0, modify afterwards -> 1
  r = run(['cancel', '--tx', 'T1', '--author', 'g'], dir);
  assert.equal(r.code, 0);
  r = run(['replace', '--tx', 'T1', '--qty', '2', '--author', 'h'], dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.error, 'TX_CANCELLED');
  r = run(['materialize', '--tx', 'T1'], dir);
  assert.equal(r.json.frozen, 0);

  // verify -> 0
  r = run(['verify'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);

  // delete index -> verify 1 -> verify --rebuild 0
  rmSync(join(dir, 'index.idx'));
  r = run(['verify'], dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.error, 'INDEX_MISSING');
  r = run(['verify', '--rebuild'], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.rebuilt, true);
  r = run(['verify'], dir);
  assert.equal(r.code, 0);

  // bad command -> 1
  r = run(['bogus'], dir);
  assert.equal(r.code, 1);
});

test('CLI: disjoint concurrent replace auto-merges (exit 0, MERGED)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txcli-'));
  let r = run(['put', '--tx', 'T9', '--price', '10', '--qty', '4', '--author', 'a'], dir);
  const base = r.json.head;
  run(['replace', '--tx', 'T9', '--price', '11', '--author', 'b', '--base', base], dir);
  r = run(['replace', '--tx', 'T9', '--qty', '6', '--author', 'c', '--base', base], dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'MERGED');
  r = run(['materialize', '--tx', 'T9'], dir);
  assert.equal(r.json.price, 11);
  assert.equal(r.json.qty, 6);
  assert.equal(r.json.frozen, 6.6);
});

test('CLI: real subprocess smoke test when spawning is permitted', (t) => {
  // The library path is covered by in-process tests above; this only checks
  // the node entrypoint wiring and is skipped where the sandbox denies spawn.
  const dir = mkdtempSync(join(tmpdir(), 'txcli-'));
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const r = spawnSync(process.execPath, [cliPath, 'put', '--tx', 'S1', '--price', '1', '--qty', '1', '--author', 'a', '--dir', dir], { encoding: 'utf8' });
  if (r.error && r.error.code === 'EPERM') {
    t.skip('subprocess spawn not permitted in this environment');
    return;
  }
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).ok, true);
});
