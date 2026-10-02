import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initPack, openPack, CrashError } from '../src/pack.js';
import { tmpdir } from './helpers.js';

function crashAdd(dir, point, payload = { crash: 'test' }) {
  const pack = openPack(dir, { failpoints: new Set([point]) });
  assert.throws(() => pack.add(payload, { member: 'alice' }),
    (err) => err instanceof CrashError && err.point === point);
}

function committedState(dir) {
  const pack = openPack(dir); // open performs orphan rollback
  const verification = pack.verify();
  const blockFiles = fs.readdirSync(path.join(dir, 'blocks'))
    .filter((n) => /^\d{6}\.json$/.test(n)).length;
  const tmpFiles = fs.readdirSync(path.join(dir, 'blocks')).filter((n) => n.includes('.tmp-'));
  return { pack, verification, blockFiles, tmpFiles };
}

test('crash before block commit leaves no trace', () => {
  const dir = tmpdir();
  initPack(dir, { members: ['alice'] }).add({ ok: 1 }, { member: 'alice' });
  const before = openPack(dir).summary();
  crashAdd(dir, 'before-block-commit');
  const s = committedState(dir);
  assert.equal(s.verification.ok, true);
  assert.equal(s.pack.count, before.count);
  assert.equal(s.pack.digest, before.digest);
  assert.equal(s.blockFiles, before.count);
  assert.deepEqual(s.tmpFiles, []);
});

test('crash after block commit but before commit record: no half-committed block', () => {
  const dir = tmpdir();
  initPack(dir, { members: ['alice'] }).add({ ok: 1 }, { member: 'alice' });
  const before = openPack(dir).summary();
  crashAdd(dir, 'before-manifest-commit');
  // The orphan block file may exist on disk, but open() must roll it back:
  // the committed view must be exactly the old state, fully verifiable.
  const s = committedState(dir);
  assert.equal(s.verification.ok, true);
  assert.equal(s.pack.count, before.count, 'half-committed block must not be visible');
  assert.equal(s.pack.digest, before.digest);
  assert.equal(s.blockFiles, before.count, 'orphan block file must be rolled back');
  // and the pack keeps accepting writes afterwards (no stuck state)
  s.pack.add({ ok: 2 }, { member: 'alice' });
  assert.equal(s.pack.verify().ok, true);
  assert.equal(s.pack.count, before.count + 1);
});

test('crash after commit record lands: block is fully committed and verifiable', () => {
  const dir = tmpdir();
  initPack(dir, { members: ['alice'] }).add({ ok: 1 }, { member: 'alice' });
  const before = openPack(dir).summary();
  crashAdd(dir, 'after-manifest-commit');
  const s = committedState(dir);
  assert.equal(s.verification.ok, true);
  assert.equal(s.pack.count, before.count + 1);
  assert.equal(s.blockFiles, before.count + 1);
  assert.notEqual(s.pack.digest, before.digest);
});

test('repeated crash-recovery cycles never produce a half-committed state', () => {
  const dir = tmpdir();
  initPack(dir, { members: ['alice'] });
  const points = ['before-block-commit', 'before-manifest-commit', 'after-manifest-commit'];
  for (let i = 0; i < 30; i += 1) {
    crashAdd(dir, points[i % 3], { i });
    const s = committedState(dir);
    assert.equal(s.verification.ok, true, `cycle ${i} (${points[i % 3]}) left inconsistent state`);
    assert.equal(s.blockFiles, s.pack.count, 'visible blocks must equal committed count');
    if (i % 3 === 2) {
      // let some writes actually land so the log grows
      s.pack.add({ landed: i }, { member: 'alice' });
    }
  }
});
