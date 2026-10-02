import test from 'node:test';
import assert from 'node:assert/strict';
import { initPack } from '../src/pack.js';
import { tmpdir } from './helpers.js';

test('membership change raises an epoch barrier', () => {
  const pack = initPack(tmpdir(), { members: ['alice', 'bob'] });
  pack.add({ n: 1 }, { member: 'alice', epoch: 0 });
  pack.add({ n: 2 }, { member: 'bob', epoch: 0 });
  pack.setMembers(['alice', 'carol'], { member: 'alice' });
  assert.equal(pack.epoch, 1);

  // old-epoch write is rejected with STALE_EPOCH
  assert.throws(() => pack.add({ n: 3 }, { member: 'alice', epoch: 0 }),
    (err) => err.code === 'STALE_EPOCH' && err.exitCode === 5);
  // removed member is rejected even with the new epoch
  assert.throws(() => pack.add({ n: 3 }, { member: 'bob', epoch: 1 }),
    (err) => err.code === 'NOT_MEMBER');
  // current member with current epoch succeeds
  pack.add({ n: 3 }, { member: 'carol', epoch: 1 });
  assert.equal(pack.count, 4);
});

test('old-epoch blocks stay readable and provable after the barrier', () => {
  const pack = initPack(tmpdir(), { members: ['alice'] });
  pack.add({ old: 1 }, { member: 'alice' });
  pack.add({ old: 2 }, { member: 'alice' });
  const digestBefore = pack.digest;
  pack.setMembers(['alice', 'dave'], { member: 'alice' });
  pack.add({ fresh: true }, { member: 'dave', epoch: 1 });

  // prove + verify inclusion for a pre-barrier block
  const proof = pack.prove(1);
  assert.equal(proof.epoch, 1);
  assert.ok(pack.verifyProof(proof).ok);
  // whole-pack verification still passes across the barrier
  assert.equal(pack.verify().ok, true);
  assert.notEqual(pack.digest, digestBefore);
});

test('stale-epoch membership change is itself rejected', () => {
  const pack = initPack(tmpdir(), { members: ['alice'] });
  pack.setMembers(['alice', 'bob'], { member: 'alice' });
  assert.throws(() => pack.setMembers(['alice'], { member: 'alice', epoch: 0 }),
    (err) => err.code === 'STALE_EPOCH');
});
