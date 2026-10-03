'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { CrashError } = require('../lib/errors');
const { tmpDir } = require('./helpers');

const E = (id, account, amount, extra = {}) => ({ id, account, amount, ...extra });

function seedDay(dir, date = '2026-10-04') {
  store.begin(dir, date);
  store.add(dir, E('e1', 'A', 100));
  store.add(dir, E('e2', 'A', -100));
  store.add(dir, E('e3', 'B', 40));
  store.add(dir, E('e4', 'B', -40, { type: 'REVERSAL', refId: 'e3' }));
  return date;
}

test('happy path rewrite respects causality and commits', () => {
  const dir = tmpDir();
  const date = seedDay(dir);
  const next = store.rewrite(dir, {
    date,
    dropIds: ['e1', 'e2'],
    fixAmounts: { e3: 60, e4: -60 },
  });
  assert.deepEqual(next.map((e) => e.id), ['e3', 'e4']);
  const snap = store.commit(dir);
  assert.deepEqual(snap.entries.map((e) => e.id), ['e3', 'e4']);
  const st = store.status(dir);
  assert.equal(st.status, 'COMMITTED_NEW');
  assert.deepEqual(st.evidence, ['HEAD', 'snapshot.json']);
});

test('cross-day rewrite rejected with exit 21', () => {
  const dir = tmpDir();
  seedDay(dir);
  assert.throws(
    () => store.rewrite(dir, { date: '2026-10-05', dropIds: [] }),
    (e) => e.code === 'E_CROSS_DAY' && e.exitCode === 21
  );
});

test('committed day is immutable: rewrite after commit rejected with exit 21', () => {
  const dir = tmpDir();
  const date = seedDay(dir);
  store.commit(dir);
  assert.throws(
    () => store.rewrite(dir, { date, dropIds: ['e1', 'e2'] }),
    (e) => e.code === 'E_CROSS_DAY' && e.exitCode === 21
  );
});

test('fault before-fsync: recover -> OPEN_OLD, wal intact, recommit works', () => {
  const dir = tmpDir();
  const date = seedDay(dir);
  store.rewrite(dir, { date, dropIds: ['e1', 'e2'] });
  assert.throws(() => store.commit(dir, { crashAt: 'before-fsync' }), (e) => e instanceof CrashError);
  const r = store.recover(dir);
  assert.equal(r.status, 'OPEN_OLD');
  assert.deepEqual(r.evidence, ['wal.jsonl']);
  assert.deepEqual(store.readWalEntries(dir).map((e) => e.id), ['e3', 'e4']);
  assert.equal(store.status(dir).status, 'OPEN_OLD');
  store.commit(dir);
  assert.equal(store.status(dir).status, 'COMMITTED_NEW');
});

test('fault before-wal-rename: recover -> OPEN_NEW, adopts durable staged snapshot', () => {
  const dir = tmpDir();
  const date = seedDay(dir);
  store.rewrite(dir, { date, dropIds: ['e1', 'e2'] });
  assert.throws(
    () => store.commit(dir, { crashAt: 'before-wal-rename' }),
    (e) => e instanceof CrashError
  );
  const r = store.recover(dir);
  assert.equal(r.status, 'OPEN_NEW');
  assert.deepEqual(r.evidence, ['snapshot.json.tmp']);
  // staged snapshot adopted as the open day's wal; day still open
  assert.deepEqual(store.readWalEntries(dir).map((e) => e.id), ['e3', 'e4']);
  assert.equal(store.status(dir).status, 'OPEN_OLD'); // tmp consumed, plain open day now
  store.commit(dir);
  assert.equal(store.status(dir).status, 'COMMITTED_NEW');
});

test('fault after-head-update: recover -> COMMITTED_NEW, snapshot valid', () => {
  const dir = tmpDir();
  const date = seedDay(dir);
  store.rewrite(dir, { date, dropIds: ['e1', 'e2'] });
  assert.throws(
    () => store.commit(dir, { crashAt: 'after-head-update' }),
    (e) => e instanceof CrashError
  );
  const r = store.recover(dir);
  assert.equal(r.status, 'COMMITTED_NEW');
  assert.deepEqual(r.evidence, ['HEAD', 'snapshot.json']);
  const snap = store.decodeSnapshot(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  assert.deepEqual(snap.entries.map((e) => e.id), ['e3', 'e4']);
  assert.ok(!fs.existsSync(path.join(dir, 'wal.jsonl.archived')), 'archived wal cleaned up');
});

test('recovery ambiguity: archived wal, no staged snapshot, HEAD open -> exit 23', () => {
  const dir = tmpDir();
  seedDay(dir);
  fs.renameSync(path.join(dir, 'wal.jsonl'), path.join(dir, 'wal.jsonl.archived'));
  assert.throws(
    () => store.recover(dir),
    (e) => e.code === 'E_RECOVER_AMBIGUOUS' && e.exitCode === 23
  );
});

test('recovery ambiguity: HEAD committed but snapshot missing -> exit 23', () => {
  const dir = tmpDir();
  seedDay(dir);
  store.commit(dir);
  fs.rmSync(path.join(dir, 'snapshot.json'));
  assert.throws(
    () => store.recover(dir),
    (e) => e.code === 'E_RECOVER_AMBIGUOUS' && e.exitCode === 23
  );
});

test('REVERSAL causality violation rejected on rewrite (exit 22)', () => {
  const dir = tmpDir();
  const date = seedDay(dir);
  assert.throws(
    () => store.rewrite(dir, { date, moveBefore: { e4: 'e3' } }),
    (e) => e.code === 'E_PLAN_INVALID' && e.exitCode === 22
  );
});

test('net protection on rewrite (exit 22)', () => {
  const dir = tmpDir();
  const date = seedDay(dir);
  assert.throws(
    () => store.rewrite(dir, { date, fixAmounts: { e3: 999 } }),
    (e) => e.code === 'E_PLAN_INVALID' && e.exitCode === 22
  );
});

test('add validates reversal reference at append time', () => {
  const dir = tmpDir();
  store.begin(dir, '2026-10-04');
  assert.throws(
    () => store.add(dir, E('x', 'A', 1, { type: 'REVERSAL', refId: 'nope' })),
    (e) => e.exitCode === 2
  );
});

test('OLD_COMMITTED on empty store and after recover of untouched store', () => {
  const dir = tmpDir();
  assert.equal(store.status(dir).status, 'OLD_COMMITTED');
  assert.equal(store.recover(dir).status, 'OLD_COMMITTED');
});
