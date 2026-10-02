import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initPack, openPack } from '../src/pack.js';
import { rng, randomPayload, tmpdir } from './helpers.js';

const clone = (src) => {
  const dst = tmpdir();
  fs.cpSync(src, dst, { recursive: true });
  return dst;
};

function buildSource(blocks, seed = 100) {
  const dir = tmpdir();
  const rand = rng(seed);
  const pack = initPack(dir, { members: ['alice'] });
  for (let i = 0; i < blocks; i += 1) pack.add(randomPayload(rand), { member: 'alice' });
  return dir;
}

test('replicas with different missing sets converge in bounded rounds', () => {
  // source timeline snapshots: S5 (5 blocks), S8 (8), S12 (12)
  const src = buildSource(5);
  const a = clone(src);          // A has blocks [0,5)
  const srcPack = openPack(src);
  const rand = rng(200);
  for (let i = 0; i < 3; i += 1) srcPack.add(randomPayload(rand), { member: 'alice' });
  const b = clone(src);          // B has blocks [0,8)
  for (let i = 0; i < 4; i += 1) srcPack.add(randomPayload(rand), { member: 'alice' });
  const s = clone(src);          // S has blocks [0,12)

  const packs = { A: openPack(a), B: openPack(b), S: openPack(s) };
  assert.equal(packs.A.count, 5);
  assert.equal(packs.B.count, 8);
  assert.equal(packs.S.count, 12);

  // round-robin anti-entropy until fixpoint; must converge in few rounds
  const targetDigest = packs.S.digest;
  let rounds = 0;
  const converged = () => Object.values(packs).every((p) => p.digest === targetDigest);
  while (!converged() && rounds < 10) {
    packs.A.syncFrom(packs.B);
    packs.B.syncFrom(packs.S);
    packs.A.syncFrom(packs.S);
    rounds += 1;
  }
  assert.ok(converged(), 'replicas did not converge');
  assert.ok(rounds <= 2, `convergence took too many rounds: ${rounds}`);
  for (const p of Object.values(packs)) {
    assert.equal(p.count, 12);
    assert.equal(p.verify().ok, true);
  }
});

test('sync is idempotent: a second sync pulls nothing', () => {
  const src = buildSource(7, 300);
  const replica = clone(buildSource(3, 300)); // same seed => same first 3 blocks
  const s = openPack(src);
  const r = openPack(replica);
  const first = r.syncFrom(s);
  assert.equal(first.pulled, 4);
  const digestAfter = r.digest;
  const second = r.syncFrom(s);
  assert.equal(second.pulled, 0);
  assert.equal(r.digest, digestAfter);
  assert.equal(r.digest, s.digest);
});

test('sync rejects divergent histories', () => {
  const d1 = buildSource(4, 1);
  const d2 = buildSource(4, 2); // different content => different chain
  const p1 = openPack(d1);
  const p2 = openPack(d2);
  assert.throws(() => p1.syncFrom(p2), (err) => err.code === 'DIVERGENT');
});

test('sync adopts newer epoch and membership from peer', () => {
  const src = buildSource(2, 500);
  const sPack = openPack(src);
  sPack.setMembers(['alice', 'carol'], { member: 'alice' });
  sPack.add({ after: 'epoch-bump' }, { member: 'carol', epoch: 1 });
  const replicaDir = tmpdir();
  const rPack = initPack(replicaDir, { members: ['alice'] });
  rPack.add({ seed: 1 }, { member: 'alice' }); // unrelated start; will diverge-check fail
  assert.throws(() => rPack.syncFrom(sPack), (err) => err.code === 'DIVERGENT');

  // clean replica that shares the prefix
  const clean = tmpdir();
  fs.cpSync(src, clean, { recursive: true });
  // rebuild an older state: init fresh and pull everything
  const fresh = tmpdir();
  const fPack = initPack(fresh, { members: ['alice'] });
  const res = fPack.syncFrom(openPack(clean));
  assert.equal(res.pulled, 4); // 2 evidence + 1 epoch block + 1 evidence
  assert.equal(fPack.epoch, 1);
  assert.deepEqual(fPack.members, ['alice', 'carol']);
  assert.equal(fPack.verify().ok, true);
  assert.equal(fPack.digest, openPack(clean).digest);
});
