import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, makePack, copyPack } from '../testing/helpers.js';

function blockPath(pack, i) {
  return path.join(pack, 'blocks', String(i).padStart(8, '0') + '.json');
}

test('acceptance 3: replicas with different missing sets converge in finite rounds', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'src');
  makePack(src, 6);
  const A = copyPack(src, path.join(dir, 'A'));   // A: committed length 6
  makePack(src, 2);                                // src grows to 8
  // re-init would fail; makePack calls init again which is a no-op, then adds 2
  const B = copyPack(src, path.join(dir, 'B'));   // B: committed length 8

  // different missing sets: A lacks interior 2,5; B lacks interior 3
  fs.rmSync(blockPath(A, 2));
  fs.rmSync(blockPath(A, 5));
  fs.rmSync(blockPath(B, 3));

  assert.equal(runCli(['verify', A]).status, 3);
  assert.equal(runCli(['verify', B]).status, 3);

  let converged = false;
  let rounds = 0;
  for (; rounds < 5; rounds++) {
    const r = runCli(['sync', A, B]);
    assert.equal(r.status, 0, `sync round ${rounds} failed: ${r.stderr}`);
    if (r.json.converged) { converged = true; rounds++; break; }
  }
  assert.ok(converged, 'did not converge within 5 rounds');
  assert.ok(rounds <= 5, `took ${rounds} rounds`);

  const va = runCli(['verify', A]);
  const vb = runCli(['verify', B]);
  assert.equal(va.status, 0);
  assert.equal(vb.status, 0);
  const da = runCli(['digest', A]).json;
  const db = runCli(['digest', B]).json;
  assert.equal(da.length, 8);
  assert.deepEqual(
    { length: da.length, head: da.head, root: da.root },
    { length: db.length, head: db.head, root: db.root },
  );
});

test('sync is idempotent: second run transfers nothing', () => {
  const dir = tmpdir();
  const A = path.join(dir, 'A');
  const B = path.join(dir, 'B');
  makePack(A, 5);
  runCli(['init', B]);
  const first = runCli(['sync', A, B]);
  assert.equal(first.status, 0);
  assert.equal(first.json.transferred.toB, 5);
  const second = runCli(['sync', A, B]);
  assert.equal(second.status, 0);
  assert.equal(second.json.transferred.toA, 0);
  assert.equal(second.json.transferred.toB, 0);
  assert.equal(second.json.converged, true);
});

test('sync pulls tail extension and verifies end-to-end', () => {
  const dir = tmpdir();
  const A = path.join(dir, 'A');
  makePack(A, 4);
  const B = copyPack(A, path.join(dir, 'B'));
  makePack(A, 3); // A grows to 7
  const r = runCli(['sync', A, B]);
  assert.equal(r.status, 0);
  assert.equal(r.json.transferred.toB, 3);
  assert.equal(r.json.converged, true);
  assert.equal(runCli(['verify', B]).status, 0);
  assert.equal(runCli(['digest', B]).json.length, 7);
});

test('sync rejects blocks served by a tampering peer', () => {
  const dir = tmpdir();
  const A = path.join(dir, 'A');
  makePack(A, 4);
  const B = copyPack(A, path.join(dir, 'B'));
  makePack(A, 2); // A grows to 6
  // corrupt A's block 5 (in the tail B would pull)
  const f = blockPath(A, 5);
  const blk = JSON.parse(fs.readFileSync(f, 'utf8'));
  blk.data.tag = 'forged-by-peer';
  fs.writeFileSync(f, JSON.stringify(blk, null, 2));
  const r = runCli(['sync', A, B]);
  assert.equal(r.status, 2);
  assert.equal(r.errJson.error.code, 'TAMPER_DETECTED');
  // B must be untouched: still length 4, verifies clean
  assert.equal(runCli(['digest', B]).json.length, 4);
  assert.equal(runCli(['verify', B]).status, 0);
});
