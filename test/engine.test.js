'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { Engine, EngineError } = require('../src/engine');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
}

function runCli(args, env = {}) {
  // The sandbox does not deliver piped child stdio, so capture via files.
  const cap = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cap-'));
  const outFile = path.join(cap, 'out');
  const errFile = path.join(cap, 'err');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, ...env },
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  res.stdout = fs.readFileSync(outFile, 'utf8');
  res.stderr = fs.readFileSync(errFile, 'utf8');
  return res;
}

// Brute-force reference implementation: scans the full record list,
// no indexes, used to cross-check the engine.
function makeReference() {
  const records = [];
  return {
    push(rec) {
      records.push(rec);
    },
    resolveById(id, at = null) {
      let cur = records.find((r) => r.id === id);
      assert.ok(cur, `reference: unknown id ${id}`);
      for (;;) {
        const correctors = records.filter(
          (r) => r.corrects === cur.id && (at === null || r.ts <= at),
        );
        if (correctors.length === 0) return cur;
        correctors.sort((a, b) => a.ts - b.ts);
        cur = correctors[correctors.length - 1];
      }
    },
    resolveByTarget(target, at = null) {
      const mine = records.filter(
        (r) => r.target === target && (at === null || r.ts <= at),
      );
      assert.ok(mine.length > 0, `reference: unknown target ${target}`);
      const newest = mine[mine.length - 1];
      return this.resolveById(newest.id, at);
    },
  };
}

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 1: chain A->B->C, resolve returns C, view-at(B time) returns B', () => {
  const dir = tmpdir();
  const e = Engine.open(dir);
  e.commit({ id: 'A', target: 'M31', value: 10, ts: 100 });
  e.commit({ id: 'B', target: 'M31', value: 11, corrects: 'A', ts: 200 });
  e.commit({ id: 'C', target: 'M31', value: 12, corrects: 'B', ts: 300 });

  assert.equal(e.resolve({ id: 'A' }).id, 'C');
  assert.equal(e.resolve({ target: 'M31' }).id, 'C');
  assert.equal(e.resolve({ id: 'B' }).id, 'C');

  assert.equal(e.viewAt({ id: 'A', at: 200 }).id, 'B');
  assert.equal(e.viewAt({ target: 'M31', at: 200 }).id, 'B');
  assert.equal(e.viewAt({ target: 'M31', at: 100 }).id, 'A');
  assert.equal(e.viewAt({ target: 'M31', at: 10_000 }).id, 'C');

  assert.deepEqual(
    e.chain('A').map((r) => r.id),
    ['A', 'B', 'C'],
  );
  e.close();
});

test('NO_TARGET when correcting a nonexistent record', () => {
  const dir = tmpdir();
  const e = Engine.open(dir);
  assert.throws(() => e.commit({ id: 'X', target: 'M31', value: 1, corrects: 'ghost' }), (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'NO_TARGET');
    return true;
  });
  e.close();

  const res = runCli(['correct', '--db', dir, '--target', 'M31', '--value', '1', '--corrects', 'ghost']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /NO_TARGET/);
});

test('CYCLE rejected: self-reference and pre-existing cyclic data', () => {
  const dir = tmpdir();
  const e = Engine.open(dir);
  assert.throws(
    () => e.commit({ id: 'S', target: 'M31', value: 1, corrects: 'S' }),
    (err) => err.code === 'CYCLE',
  );
  e.close();

  const res = runCli(['correct', '--db', dir, '--target', 'M31', '--value', '1', '--id', 'S', '--corrects', 'S']);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /CYCLE/);

  // Fabricate a cyclic WAL directly (A<->B), then a new correction that
  // would traverse the cycle must be rejected with CYCLE.
  const dir2 = tmpdir();
  fs.mkdirSync(dir2, { recursive: true });
  const { Wal } = require('../src/wal');
  const wal = new Wal(path.join(dir2, 'wal.log'));
  wal.open();
  wal.append({ type: 'commit', record: { id: 'A', target: 'X', value: 1, corrects: 'B', ts: 1, seq: 1 } });
  wal.append({ type: 'commit', record: { id: 'B', target: 'X', value: 2, corrects: 'A', ts: 2, seq: 2 } });
  wal.close();
  const e2 = Engine.open(dir2);
  assert.throws(
    () => e2.commit({ id: 'C', target: 'X', value: 3, corrects: 'A' }),
    (err) => err.code === 'CYCLE',
  );
  e2.close();
});

test('acceptance 2: crash after WAL flush, before index flush -> verify passes after restart', () => {
  const dir = tmpdir();
  let res = runCli(['correct', '--db', dir, '--target', 'M31', '--value', '10', '--id', 'A', '--ts', '100']);
  assert.equal(res.status, 0, res.stderr);

  // This commit dies right after the WAL fsync, before indexes persist.
  res = runCli(
    ['correct', '--db', dir, '--target', 'M31', '--value', '11', '--corrects', 'A', '--id', 'B', '--ts', '200'],
    { OBS_CRASH_AFTER_WAL: '1' },
  );
  assert.equal(res.status, 42);

  // The crashed commit must be visible after recovery (WAL is authoritative).
  res = runCli(['resolve', '--db', dir, '--id', 'A']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).id, 'B');

  res = runCli(['verify', '--db', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK|REBUILT/);

  // A second verify on the repaired state is a clean OK.
  res = runCli(['verify', '--db', dir]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^OK/);
});

test('corrupt index files are rebuilt from WAL and verify passes', () => {
  const dir = tmpdir();
  const e = Engine.open(dir);
  e.commit({ id: 'A', target: 'M31', value: 10, ts: 100 });
  e.commit({ id: 'B', target: 'M31', value: 11, corrects: 'A', ts: 200 });
  e.close();

  fs.writeFileSync(path.join(dir, 'index-name.json'), 'garbage{{{');
  const time = JSON.parse(fs.readFileSync(path.join(dir, 'index-time.json'), 'utf8'));
  time.data = [['tampered']];
  fs.writeFileSync(path.join(dir, 'index-time.json'), JSON.stringify(time));

  // Open-time recovery reconciles the corrupt files; verify passes and
  // the data derived from the WAL is intact.
  const res = runCli(['verify', '--db', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK|REBUILT/);

  const res2 = runCli(['resolve', '--db', dir, '--target', 'M31']);
  assert.equal(JSON.parse(res2.stdout).id, 'B');

  // verify() itself also repairs: corrupt the files underneath an open
  // engine and confirm verify reports and fixes the divergence.
  const e2 = Engine.open(dir);
  fs.writeFileSync(path.join(dir, 'index-name.json'), 'garbage{{{');
  const t2 = JSON.parse(fs.readFileSync(path.join(dir, 'index-time.json'), 'utf8'));
  t2.data = [['tampered']];
  fs.writeFileSync(path.join(dir, 'index-time.json'), JSON.stringify(t2));
  const verdict = e2.verify();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.repaired, true);
  assert.deepEqual(e2.verify(), { ok: true, repaired: false, problems: [] });
  e2.close();
});

test('torn WAL tail is truncated on recovery', () => {
  const dir = tmpdir();
  const e = Engine.open(dir);
  e.commit({ id: 'A', target: 'M31', value: 10, ts: 100 });
  e.close();

  // Simulate a crash mid-frame: append half a frame.
  const fd = fs.openSync(path.join(dir, 'wal.log'), 'a');
  fs.writeSync(fd, Buffer.from([5, 0, 0, 0, 123, 34]));
  fs.closeSync(fd);

  const e2 = Engine.open(dir);
  assert.equal(e2.resolve({ id: 'A' }).id, 'A');
  e2.commit({ id: 'B', target: 'M31', value: 11, corrects: 'A', ts: 200 });
  e2.close();

  const e3 = Engine.open(dir);
  assert.equal(e3.resolve({ id: 'A' }).id, 'B');
  e3.close();
});

test('acceptance 3: 300 random corrections cross-checked against brute-force reference', () => {
  const dir = tmpdir();
  const e = Engine.open(dir);
  const ref = makeReference();
  const rand = rng(20261003);
  const ids = [];
  const targets = [];
  let ts = 1000;

  for (let i = 0; i < 300; i++) {
    const roll = rand();
    let rec;
    if (roll < 0.4 || ids.length === 0) {
      const target = `T${Math.floor(rand() * 12)}`;
      rec = { id: `r${i}`, target, value: Math.floor(rand() * 1e6), ts: ++ts };
      targets.push(target);
    } else {
      const base = ids[Math.floor(rand() * ids.length)];
      const baseRec = e.chain(base)[0];
      rec = {
        id: `r${i}`,
        target: baseRec.target,
        value: Math.floor(rand() * 1e6),
        corrects: base,
        ts: ++ts,
      };
    }
    const committed = e.commit(rec);
    ref.push(committed);
    ids.push(committed.id);
  }

  // Every record: resolve by id matches the brute-force scan.
  for (const id of ids) {
    assert.equal(e.resolve({ id }).id, ref.resolveById(id).id, `resolve by id ${id}`);
  }
  // Every target: resolve by target matches.
  for (const target of new Set(targets)) {
    assert.equal(e.resolve({ target }).id, ref.resolveByTarget(target).id, `resolve target ${target}`);
  }
  // Spot-check historical views at 25 random timestamps.
  for (let i = 0; i < 25; i++) {
    const at = 1000 + Math.floor(rand() * (ts - 1000));
    for (const target of new Set(targets)) {
      const hadRecords = e.nameIndex.ids(target).some((id) => e.records.get(id).ts <= at);
      if (!hadRecords) {
        assert.throws(() => e.viewAt({ target, at }), (err) => err.code === 'NOT_FOUND');
        continue;
      }
      const got = e.viewAt({ target, at });
      const want = ref.resolveByTarget(target, at);
      assert.equal(got.id, want.id, `view-at ${target} @ ${at}`);
    }
  }
  e.close();

  // Reopen from disk and re-verify a sample to prove durability.
  const e2 = Engine.open(dir);
  for (let i = 0; i < 30; i++) {
    const id = ids[Math.floor(rand() * ids.length)];
    assert.equal(e2.resolve({ id }).id, ref.resolveById(id).id);
  }
  assert.deepEqual(e2.verify(), { ok: true, repaired: false, problems: [] });
  e2.close();
});

test('time index supports range queries', () => {
  const dir = tmpdir();
  const e = Engine.open(dir);
  e.commit({ id: 'A', target: 'X', value: 1, ts: 100 });
  e.commit({ id: 'B', target: 'Y', value: 2, ts: 200 });
  e.commit({ id: 'C', target: 'Z', value: 3, ts: 300 });
  assert.deepEqual(e.range(150, 300).map((r) => r.id), ['B', 'C']);
  assert.deepEqual(e.range(null, 100).map((r) => r.id), ['A']);
  e.close();
});

test('CLI end-to-end: correct/resolve/view-at/chain/verify', () => {
  const dir = tmpdir();
  assert.equal(runCli(['correct', '--db', dir, '--target', 'M31', '--value', '10', '--id', 'A', '--ts', '100']).status, 0);
  assert.equal(runCli(['correct', '--db', dir, '--target', 'M31', '--value', '11', '--corrects', 'A', '--id', 'B', '--ts', '200']).status, 0);
  assert.equal(runCli(['correct', '--db', dir, '--target', 'M31', '--value', '12', '--corrects', 'B', '--id', 'C', '--ts', '300']).status, 0);

  let res = runCli(['resolve', '--db', dir, '--id', 'A']);
  assert.equal(JSON.parse(res.stdout).value, 12);

  res = runCli(['view-at', '--db', dir, '--target', 'M31', '--at', '200']);
  assert.equal(JSON.parse(res.stdout).value, 11);

  res = runCli(['chain', '--db', dir, '--id', 'A']);
  const links = res.stdout.trim().split('\n').map((l) => JSON.parse(l).id);
  assert.deepEqual(links, ['A', 'B', 'C']);

  res = runCli(['verify', '--db', dir]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^OK/);

  res = runCli(['resolve', '--db', dir, '--id', 'nope']);
  assert.equal(res.status, 5);
  assert.match(res.stderr, /NOT_FOUND/);
});
