import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cli-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function runCli(dir, cmdName = 'cmd.jsonl') {
  // The sandboxed environment cannot pipe child stdio back, so capture via
  // file redirection instead.
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const res = spawnSync(
    process.execPath,
    [CLI, path.join(dir, cmdName), path.join(dir, 'journal.jsonl')],
    { stdio: ['ignore', outFd, errFd] },
  );
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  assert.equal(res.error, undefined);
  return {
    status: res.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('CLI runs import/equiv/rollback and prints JSON lines', () => {
  const dir = setup({
    'l1.jsonl': jsonl([
      { meta: 'start', start: 'raw' },
      { batch: 'raw', defects: ['d0'], on: { merge: 'blend' } },
      { batch: 'blend', parents: ['raw'], defects: [], on: { test: 'blend' } },
    ]),
    'l2.jsonl': jsonl([
      { batch: 'pack', parents: ['blend'], defects: ['d9'], on: { ship: 'pack' } },
    ]),
    'v1.jsonl': jsonl([
      { batch: 's0', defects: [], on: { merge: 's1' } },
      { batch: 's1', parents: ['s0'], defects: [], on: { test: 's2' } },
      { batch: 's2', parents: ['s1'], defects: ['dx'], on: { ship: 's2' } },
    ]),
    'v2.jsonl': jsonl([
      { batch: 't0', defects: [], on: { merge: 't1' } },
      { batch: 't1', parents: ['t0'], defects: [], on: { test: 't2' } },
      { batch: 't2', parents: ['t1'], defects: [], on: { ship: 't2' } },
    ]),
    'cmd.jsonl': jsonl([
      { cmd: 'import', file: 'l1.jsonl', layer: 1 },
      { cmd: 'import', file: 'l2.jsonl', layer: 2 },
      { cmd: 'equiv', a: 'v1.jsonl', b: 'v2.jsonl' },
      { cmd: 'rollback', layer: 2 },
    ]),
  });
  const res = runCli(dir);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out[0].cmd, 'import');
  assert.equal(out[0].layer, 1);
  assert.equal(out[0].recoveredTo, 1);
  assert.equal(typeof out[0].minStates, 'number');
  assert.equal(out[1].recoveredTo, 2);
  assert.equal(out[2].cmd, 'equiv');
  assert.equal(out[2].equal, false);
  assert.deepEqual(out[2].witness, ['merge', 'test']);
  // v2's states are all bisimilar (empty defect sets everywhere), so it
  // minimizes to a single state; v1 keeps 4 (dx is reachable only via s2).
  assert.deepEqual(out[2].minStates, [4, 1]);
  assert.equal(out[3].cmd, 'rollback');
  assert.equal(out[3].recoveredTo, 1);
});

test('CLI exits 4 on cyclic lineage', () => {
  const dir = setup({
    'bad.jsonl': jsonl([
      { batch: 'a', parents: ['b'] },
      { batch: 'b', parents: ['a'] },
    ]),
    'cmd.jsonl': jsonl([{ cmd: 'import', file: 'bad.jsonl' }]),
  });
  const res = runCli(dir);
  assert.equal(res.status, 4);
  assert.equal(JSON.parse(res.stderr).error.code, 'CYCLIC_LINEAGE');
});

test('CLI exits 4 on unknown parent batch', () => {
  const dir = setup({
    'bad.jsonl': jsonl([{ batch: 'a', parents: ['ghost'] }]),
    'cmd.jsonl': jsonl([{ cmd: 'import', file: 'bad.jsonl' }]),
  });
  const res = runCli(dir);
  assert.equal(res.status, 4);
  assert.equal(JSON.parse(res.stderr).error.code, 'UNKNOWN_PARENT');
});

test('CLI exits 4 on layer hole', () => {
  const dir = setup({
    'ok.jsonl': jsonl([{ batch: 'a', defects: [] }]),
    'cmd.jsonl': jsonl([
      { cmd: 'import', file: 'ok.jsonl', layer: 1 },
      { cmd: 'import', file: 'ok.jsonl', layer: 3 },
    ]),
  });
  const res = runCli(dir);
  assert.equal(res.status, 4);
  assert.equal(JSON.parse(res.stderr).error.code, 'LAYER_HOLE');
});
