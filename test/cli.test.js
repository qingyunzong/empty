import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCertificate } from '../src/replica.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'recon-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let outCounter = 0;
// NOTE: stdout is captured through a file redirect because nested node
// processes cannot inherit this sandbox's stdout pipe.
function run(...args) {
  outCounter += 1;
  const outFile = path.join(dir, `out-${outCounter}.json`);
  const fd = openSync(outFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const text = readFileSync(outFile, 'utf8').trim();
  return { code: res.status, json: text ? JSON.parse(text) : null };
}

const A = () => path.join(dir, 'a.json');
const B = () => path.join(dir, 'b.json');
const SNAP_A = () => path.join(dir, 'snapA.json');

function seedBoth() {
  for (const f of [A(), B()]) {
    assert.equal(run('upsert', f, 'r1', '100', '100').code, 0);
    assert.equal(run('upsert', f, 'r3', '30', '30').code, 0);
  }
  assert.equal(run('merge', A(), B()).code, 0);
  assert.equal(run('merge', B(), A()).code, 0);
}

test('CLI: full anti-entropy flow (diff finds missing record+tombstone, merge repairs)', () => {
  seedBoth();
  assert.equal(run('upsert', A(), 'r2', '50', '45').code, 0);
  assert.equal(run('delete', A(), 'r3').code, 0);

  const snapA = run('snapshot', A());
  assert.equal(snapA.code, 0);
  writeFileSync(SNAP_A(), JSON.stringify(snapA.json));

  const diff = run('diff', B(), SNAP_A());
  assert.equal(diff.code, 0);
  assert.equal(diff.json.equal, false);
  assert.deepEqual(diff.json.missingRecords, ['r2']);
  assert.deepEqual(diff.json.missingTombstones, ['r3']);

  const merge = run('merge', B(), A());
  assert.equal(merge.code, 0);
  assert.equal(merge.json.status, 'ok');

  const sa = run('snapshot', A()).json;
  const sb = run('snapshot', B()).json;
  assert.equal(sa.digest, sb.digest);
  assert.equal(sa.epoch, sb.epoch);
  assert.equal(sb.certificate.valid, true);
  assert.ok(verifyCertificate(sb.certificate));

  const diffAfter = run('diff', B(), SNAP_A());
  assert.equal(diffAfter.json.equal, true);
  assert.deepEqual(diffAfter.json.missingRecords, []);
  assert.deepEqual(diffAfter.json.missingTombstones, []);
});

test('CLI: stale replay is rejected with exit 1 and no resurrection', () => {
  seedBoth();
  assert.equal(run('delete', A(), 'r1').code, 0);
  assert.equal(run('upsert', B(), 'r1', '100', '100').code, 0); // stale replay

  const merge = run('merge', A(), B());
  assert.equal(merge.code, 1);
  assert.equal(merge.json.error, 'stale-resurrect');

  const snap = run('snapshot', A()).json;
  const r1 = snap.entries.find((e) => e.id === 'r1');
  assert.equal(r1.type, 'tombstone'); // not resurrected

  // Healing direction works and converges.
  assert.equal(run('merge', B(), A()).code, 0);
  assert.equal(run('snapshot', A()).json.digest, run('snapshot', B()).json.digest);
});

test('CLI: concurrent resolve/delete yields conflict and invalid certificate', () => {
  seedBoth();
  assert.equal(run('resolve', A(), 'r1').code, 0);
  assert.equal(run('delete', B(), 'r1').code, 0);

  const m1 = run('merge', A(), B());
  assert.equal(m1.code, 0);
  assert.equal(m1.json.status, 'conflict');
  const m2 = run('merge', B(), A());
  assert.equal(m2.json.status, 'conflict');

  const sa = run('snapshot', A()).json;
  const sb = run('snapshot', B()).json;
  assert.equal(sa.digest, sb.digest);
  assert.equal(sa.certificate.valid, false);
  assert.equal(sb.certificate.valid, false);
  assert.deepEqual(sa.certificate.conflicts, [{ id: 'r1', reason: 'concurrent-resolve-delete' }]);
});

test('CLI: errors are JSON with exit code 1', () => {
  const notFound = run('resolve', A(), 'ghost');
  assert.equal(notFound.code, 1);
  assert.deepEqual(notFound.json, { error: 'not-found', id: 'ghost' });

  const delMissing = run('delete', A(), 'ghost');
  assert.equal(delMissing.code, 1);
  assert.equal(delMissing.json.error, 'not-found');

  const usage = run('upsert', A(), 'r1', 'not-a-number', '1');
  assert.equal(usage.code, 1);
  assert.equal(usage.json.error, 'usage');

  const noCmd = run();
  assert.equal(noCmd.code, 1);
  assert.equal(noCmd.json.error, 'usage');
});

test('CLI: merge also accepts a snapshot file', () => {
  seedBoth();
  assert.equal(run('upsert', A(), 'r7', '7', '7').code, 0);
  const snapA = run('snapshot', A()).json;
  writeFileSync(SNAP_A(), JSON.stringify(snapA));
  assert.equal(run('merge', B(), SNAP_A()).code, 0);
  assert.equal(run('snapshot', A()).json.digest, run('snapshot', B()).json.digest);
});
