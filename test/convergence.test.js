import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mktmp, runCli, seedDir, readJson } from '../support/helpers.js';

test('bidirectional convergence: disjoint edits merge to identical state on both replicas', () => {
  const root = mktmp();
  const A = seedDir(root, 'A');
  const B = seedDir(root, 'B');
  fs.cpSync(path.join(A, 'seed.json'), path.join(B, 'seed.json'));

  let r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":4}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.changeId, 'A:1');

  r = runCli(['apply', '--dir', B, '--node', 'B', '--type', 'move', '--data', '{"id":"o3","machine":"M3","start":0}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.changeId, 'B:1');

  r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'insert',
    '--data', '{"id":"o4","job":"j2","machine":"M3","start":3,"dur":1,"preds":["o3"],"machines":["M3"]}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.changeId, 'A:2');

  r = runCli(['sync', '--dir', A, '--peer', B]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.clock, { A: 2, B: 1 });
  assert.equal(r.json.logLen, 3);
  assert.deepEqual(r.json.pending, []);

  for (const dir of [A, B]) {
    const v = runCli(['verify', '--dir', dir]);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.json.cost, 0);
  }

  const logA = fs.readFileSync(path.join(A, 'log.jsonl'), 'utf8');
  const logB = fs.readFileSync(path.join(B, 'log.jsonl'), 'utf8');
  assert.equal(logA, logB, 'both replicas hold identical merged logs');

  const certA = runCli(['export-cert', '--dir', A, '--out', path.join(root, 'certA.json')]);
  const certB = runCli(['export-cert', '--dir', B, '--out', path.join(root, 'certB.json')]);
  assert.equal(certA.json.certHash, certB.json.certHash);
  assert.equal(
    fs.readFileSync(path.join(root, 'certA.json'), 'utf8'),
    fs.readFileSync(path.join(root, 'certB.json'), 'utf8'),
  );

  const snapA = readJson(path.join(A, 'snapshot.json'));
  const snapB = readJson(path.join(B, 'snapshot.json'));
  assert.deepEqual(snapA, snapB);

  const syncAgain = runCli(['sync', '--dir', A, '--peer', B]);
  assert.equal(syncAgain.code, 0);
  const certA2 = runCli(['export-cert', '--dir', A]);
  assert.equal(certA2.json.certHash, certA.json.certHash, 'sync is idempotent');
});

test('sync rejects replicas with different base plans (exit 2)', () => {
  const root = mktmp();
  const A = seedDir(root, 'A');
  const B = seedDir(root, 'B');
  const other = basePlanOther();
  fs.writeFileSync(path.join(B, 'seed.json'), JSON.stringify(other));
  const r = runCli(['sync', '--dir', A, '--peer', B]);
  assert.equal(r.code, 2);
  assert.equal(r.errJson.error.code, 2);
  assert.equal(r.errJson.error.type, 'validation');
});

function basePlanOther() {
  return { jobs: [{ id: 'j1', due: 1, weight: 1 }], ops: [] };
}
