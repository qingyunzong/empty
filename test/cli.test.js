'use strict';
// CLI smoke check from within node:test. Some sandboxes block child-process
// spawning (EPERM); in that case we skip — the full CLI e2e lives in
// test/cli.e2e.sh and is run directly by the shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

function spawnBlocked() {
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  return probe.stdout !== 'ok';
}

test('CLI: load + recall roundtrip via subprocess', (t) => {
  if (spawnBlocked()) {
    t.skip('child processes blocked in this sandbox; run test/cli.e2e.sh instead');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'recall-cli-'));
  const store = join(dir, 'store.json');
  const batchFile = join(dir, 'b1.json');
  writeFileSync(batchFile, JSON.stringify({
    batchId: 'B1',
    docs: [{ id: 'D1', description: '缸体裂纹扩展', defectCode: 'CRK01', batchCode: 'LOT1' }],
  }));
  const run = (...args) => spawnSync(process.execPath, [CLI, '--store', store, ...args], { encoding: 'utf8' });
  const load = run('load', batchFile);
  assert.equal(load.status, 0, load.stderr);
  assert.equal(JSON.parse(load.stdout).epoch, 1);
  const recall = run('recall', '--phrase', '裂纹 扩展');
  assert.equal(recall.status, 0, recall.stderr);
  assert.deepEqual(JSON.parse(recall.stdout).hits, ['D1']);
  const dup = run('load', batchFile);
  assert.equal(dup.status, 3);
  assert.match(dup.stderr, /E_DUP/);
});
