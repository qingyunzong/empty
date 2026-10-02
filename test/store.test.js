import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openStore,
  StoreError,
  TARGET_INDEX_FILE,
  TIME_INDEX_FILE,
} from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cli = path.join(root, 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-store-'));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force reference: scan every committed record, no indexes involved.
function bruteResolve(records, target, tMax = Infinity) {
  const cand = records.filter((r) => r.target === target && r.t <= tMax);
  if (cand.length === 0) return null;
  const corrected = new Set(cand.map((r) => r.corrects).filter((x) => x !== null));
  const tails = cand.filter((r) => !corrected.has(r.id));
  return tails.reduce((a, b) => (b.seq > a.seq ? b : a));
}

test('acceptance 1: chain A->B->C, resolve returns C, view-at(tB) returns B', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  const a = store.commit({ target: 'M31', value: 'mag=4.0', t: 100 });
  const b = store.commit({ corrects: a.id, value: 'mag=4.1', t: 200 });
  const c = store.commit({ corrects: b.id, value: 'mag=4.2', t: 300 });

  assert.equal(store.resolve('M31').id, c.id);
  assert.equal(store.viewAt('M31', 200).id, b.id);
  assert.equal(store.viewAt('M31', 150).id, a.id);
  assert.deepEqual(
    store.chain('M31').map((r) => r.id),
    [a.id, b.id, c.id],
  );
  store.close();

  // Same results after a restart (WAL replay).
  const reopened = openStore(dir);
  assert.equal(reopened.resolve('M31').id, c.id);
  assert.equal(reopened.viewAt('M31', 200).id, b.id);
  reopened.close();
});

test('error contract: NO_TARGET for unknown record, CYCLE for cyclic reference', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  assert.throws(() => store.commit({ corrects: 'ghost', value: 1 }), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'NO_TARGET');
    return true;
  });
  const a = store.commit({ id: 'A', target: 'X', value: 1, t: 1 });
  store.commit({ id: 'B', value: 2, corrects: a.id, t: 2 });
  assert.throws(() => store.commit({ id: 'A', value: 3, corrects: 'B', t: 3 }), (err) => {
    assert.equal(err.code, 'CYCLE');
    return true;
  });
  assert.equal(store.resolve('X').id, 'B'); // failed commit left no trace
  store.close();
});

test('acceptance 2: crash before index flush, verify passes after restart', () => {
  const dir = tmpdir();
  const fixture = path.join(root, 'fixtures', 'crash-commit.mjs');
  const res = spawnSync(process.execPath, [fixture, dir]);
  assert.notEqual(res.status, 0, 'fixture must crash');
  assert.equal(fs.existsSync(path.join(dir, TARGET_INDEX_FILE)), false);
  assert.equal(fs.existsSync(path.join(dir, TIME_INDEX_FILE)), false);

  const store = openStore(dir);
  assert.equal(store.resolve('CRASH-T').id, 'C'); // WAL replay recovered everything
  const v1 = store.verify();
  assert.equal(v1.ok, true);
  assert.equal(v1.rebuilt, true, 'indexes were missing and got rebuilt');
  store.close();

  const again = openStore(dir);
  const v2 = again.verify();
  assert.equal(v2.ok, true);
  assert.equal(v2.rebuilt, false, 'rebuilt indexes now match the WAL');
  assert.equal(again.resolve('CRASH-T').value, 'v3');
  again.close();
});

test('corrupt index files are rebuilt from the WAL', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  const a = store.commit({ target: 'VEGA', value: 'v1', t: 1 });
  const b = store.commit({ corrects: a.id, value: 'v2', t: 2 });
  store.close();

  fs.writeFileSync(path.join(dir, TARGET_INDEX_FILE), '{ not json !!!');
  fs.writeFileSync(path.join(dir, TIME_INDEX_FILE), '{"t": 999, "garbage": true}');

  const reopened = openStore(dir);
  const v = reopened.verify();
  assert.equal(v.ok, true);
  assert.equal(v.rebuilt, true);
  assert.equal(reopened.resolve('VEGA').id, b.id);
  assert.equal(reopened.verify().rebuilt, false);
  reopened.close();
});

test('acceptance 3: 300 random corrections match brute-force reference', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  const rand = mulberry32(42);
  const targets = ['VEGA', 'ALTAIR', 'DENEB', 'SIRIUS', 'RIGEL'];
  const ref = [];
  for (let i = 0; i < 300; i++) {
    const value = `m${i}`;
    const t = i + 1;
    let rec;
    if (ref.length > 0 && rand() < 0.85) {
      const parent = ref[Math.floor(rand() * ref.length)];
      rec = store.commit({ value, corrects: parent.id, t });
    } else {
      const target = targets[Math.floor(rand() * targets.length)];
      rec = store.commit({ value, target, t });
    }
    ref.push({ ...rec });
  }
  for (const target of targets) {
    assert.equal(
      store.resolve(target)?.id ?? null,
      bruteResolve(ref, target)?.id ?? null,
      `resolve(${target})`,
    );
    for (const tMax of [50, 150, 250]) {
      assert.equal(
        store.viewAt(target, tMax)?.id ?? null,
        bruteResolve(ref, target, tMax)?.id ?? null,
        `viewAt(${target}, ${tMax})`,
      );
    }
  }
  store.close();

  const reopened = openStore(dir);
  for (const target of targets) {
    assert.equal(
      reopened.resolve(target)?.id ?? null,
      bruteResolve(ref, target)?.id ?? null,
      `resolve(${target}) after restart`,
    );
  }
  assert.equal(reopened.verify().ok, true);
  reopened.close();
});

test('CLI: correct/resolve/view-at/chain/verify and error exit codes', () => {
  const dir = tmpdir();
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args, '--data', dir], { encoding: 'utf8' });

  let r = run('correct', '--target', 'M31', '--value', '4.0', '--time', '100');
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(r.stdout);
  r = run('correct', '--corrects', a.id, '--value', '4.1', '--time', '200');
  assert.equal(r.status, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  r = run('correct', '--corrects', b.id, '--value', '4.2', '--time', '300');
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);

  r = run('resolve', '--target', 'M31');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, c.id);

  r = run('view-at', '--target', 'M31', '--time', '200');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, b.id);

  r = run('chain', '--target', 'M31');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.stdout.trim().split('\n').map((l) => JSON.parse(l).id),
    [a.id, b.id, c.id],
  );

  r = run('range', '--from', '150', '--to', '300');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.stdout.trim().split('\n').map((l) => JSON.parse(l).id),
    [b.id, c.id],
  );

  r = run('verify');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^(OK|REBUILT)\n$/);

  r = run('correct', '--corrects', 'nope', '--value', '1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NO_TARGET/);

  r = run('correct', '--id', a.id, '--corrects', c.id, '--value', '9');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /CYCLE/);

  r = run('resolve', '--target', 'UNKNOWN');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NO_TARGET/);
});
