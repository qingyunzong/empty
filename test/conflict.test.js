import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mktmp, runCli, seedDir } from '../support/helpers.js';

function conflictScenario(root) {
  const A = seedDir(root, 'A');
  const B = seedDir(root, 'B');
  fs.cpSync(path.join(A, 'seed.json'), path.join(B, 'seed.json'));
  fs.cpSync(path.join(A, 'constraints.json'), path.join(B, 'constraints.json'));
  return { A, B };
}

test('concurrent moves of same op: deterministic winner, loser pending, reproducible certificate', () => {
  const run = () => {
    const root = mktmp();
    const { A, B } = conflictScenario(root);
    let r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","start":5}']);
    assert.equal(r.code, 0, r.stderr);
    r = runCli(['apply', '--dir', B, '--node', 'B', '--type', 'move', '--data', '{"id":"o3","start":1}']);
    assert.equal(r.code, 0, r.stderr);
    r = runCli(['sync', '--dir', A, '--peer', B]);
    assert.equal(r.code, 3, 'sync exits 3 with unresolved conflict pending');
    assert.deepEqual(r.json.pending, [{ changeId: 'A:1', op: 'o3', reason: 'conflict-move' }]);
    assert.equal(r.json.conflicts.length, 1);
    const c = r.json.conflicts[0];
    assert.equal(c.op, 'o3');
    assert.deepEqual(c.contenders, ['A:1', 'B:1']);
    assert.deepEqual(c.winners, ['B:1'], 'lower-cost move wins');
    assert.equal(c.rule, 'min-cost-then-changeId');
    assert.deepEqual(c.costs, { 'A:1': 8, 'B:1': 0 });
    const certA = runCli(['export-cert', '--dir', A, '--out', path.join(root, 'certA.json')]);
    const certB = runCli(['export-cert', '--dir', B, '--out', path.join(root, 'certB.json')]);
    assert.equal(certA.code, 0);
    assert.equal(certB.code, 0);
    assert.equal(certA.json.certHash, certB.json.certHash, 'both replicas produce identical certificates');
    return { root, A, B, certHash: certA.json.certHash };
  };

  const first = run();
  const second = run();
  assert.equal(first.certHash, second.certHash, 'certificate is reproducible across independent runs');

  const cert = JSON.parse(fs.readFileSync(path.join(first.root, 'certA.json'), 'utf8'));
  assert.equal(cert.conflicts[0].winners[0], 'B:1');
  assert.deepEqual(cert.pending, [{ changeId: 'A:1', op: 'o3', reason: 'conflict-move' }]);

  const v = runCli(['verify', '--dir', first.A]);
  assert.equal(v.code, 3, 'verify exits 3 for pending conflict, not 2: pending is not unsatisfiable');
  assert.deepEqual(v.json.violations, []);
  assert.equal(v.json.pending.length, 1);

  const applyMore = runCli(['apply', '--dir', first.A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":4}']);
  assert.equal(applyMore.code, 0, 'replica keeps accepting changes while conflict is pending');

  const syncAgain = runCli(['sync', '--dir', first.A, '--peer', first.B]);
  assert.equal(syncAgain.code, 3, 'pending conflict persists deterministically across re-sync');
  const certAfter = runCli(['export-cert', '--dir', first.A]);
  assert.notEqual(certAfter.json.certHash, first.certHash, 'new change alters certificate');
});

test('concurrent moves with equal cost: tie broken by smaller changeId', () => {
  const root = mktmp();
  const { A, B } = conflictScenario(root);
  runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","machine":"M3","start":0}']);
  runCli(['apply', '--dir', B, '--node', 'B', '--type', 'move', '--data', '{"id":"o3","machine":"M2","start":0}']);
  const r = runCli(['sync', '--dir', A, '--peer', B]);
  assert.equal(r.code, 3);
  assert.deepEqual(r.json.conflicts[0].winners, ['A:1'], 'A:1 < B:1 wins the tie');
  assert.deepEqual(r.json.pending, [{ changeId: 'B:1', op: 'o3', reason: 'conflict-move' }]);
});

test('concurrent cancel vs move: cancel wins, move pending', () => {
  const root = mktmp();
  const { A, B } = conflictScenario(root);
  runCli(['apply', '--dir', A, '--node', 'A', '--type', 'cancel', '--data', '{"id":"o3"}']);
  runCli(['apply', '--dir', B, '--node', 'B', '--type', 'move', '--data', '{"id":"o3","start":1}']);
  const r = runCli(['sync', '--dir', A, '--peer', B]);
  assert.equal(r.code, 3);
  assert.equal(r.json.conflicts[0].rule, 'cancel-wins');
  assert.deepEqual(r.json.conflicts[0].winners, ['A:1']);
  assert.deepEqual(r.json.pending, [{ changeId: 'B:1', op: 'o3', reason: 'conflict-move' }]);
  const cert = runCli(['export-cert', '--dir', A]).json.cert;
  assert.equal(cert.planHash, runCli(['export-cert', '--dir', B]).json.cert.planHash);
});
