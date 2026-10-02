'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/archive');
const cli = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arch-repair-'));
}

function buf(seed, len) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}

function flipByte(file, offset) {
  const data = fs.readFileSync(file);
  data[offset] ^= 0xff;
  fs.writeFileSync(file, data);
}

function snapshotDir(dir) {
  const snap = new Map();
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else snap.set(path.relative(dir, p), fs.readFileSync(p));
    }
  };
  walk(dir);
  return snap;
}

function assertDirEquals(snap, dir) {
  const now = snapshotDir(dir);
  assert.deepEqual([...now.keys()].sort(), [...snap.keys()].sort(), 'file sets differ');
  for (const [rel, data] of snap) {
    assert.deepEqual(now.get(rel), data, `content differs: ${rel}`);
  }
}

// Acceptance 1: enumerate every corruption position in a small archive and
// compare against inspect output.
test('inspect: exhaustive corruption positions over all subsets', () => {
  const dir = tmpdir();
  const originals = [buf(1, 16), buf(2, 16), buf(3, 16)];
  lib.createArchive(dir, originals);
  const files = originals.map((_, i) => path.join(dir, lib.chunkFileName(i)));

  const n = originals.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    originals.forEach((d, i) => fs.writeFileSync(files[i], d)); // restore
    const expected = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        flipByte(files[i], 0);
        expected.push(i);
      }
    }
    const report = lib.inspect(dir);
    assert.deepEqual(report.corrupt, expected, `mask=${mask.toString(2)}`);
    assert.equal(report.ok, expected.length === 0);
  }

  // missing chunk file is corrupt
  originals.forEach((d, i) => fs.writeFileSync(files[i], d)); // restore
  fs.rmSync(files[1]);
  assert.deepEqual(lib.inspect(dir).corrupt, [1]);
});

// Damage rule: weak (adler32) hit + strong (sha256) fail still counts as
// corrupt. [0,2,0] and [1,0,1] share the same adler32.
test('inspect: weak checksum collision does not clear strong hash failure', () => {
  const dir = tmpdir();
  lib.createArchive(dir, [Buffer.from([0, 2, 0])]);
  assert.equal(lib.adler32hex(Buffer.from([0, 2, 0])), lib.adler32hex(Buffer.from([1, 0, 1])));
  fs.writeFileSync(path.join(dir, lib.chunkFileName(0)), Buffer.from([1, 0, 1]));
  const report = lib.inspect(dir);
  assert.deepEqual(report.corrupt, [0]);
  assert.equal(report.chunks[0].reason, 'weak-collision');
});

// Acceptance 2: budget boundary, exact fit vs one byte short.
test('planRepair: budget boundary exact and minus one byte', () => {
  const arc = tmpdir();
  const good = tmpdir();
  const chunks = [buf(1, 100), buf(2, 50), buf(3, 40)];
  lib.createArchive(arc, chunks);
  lib.createArchive(good, chunks);
  flipByte(path.join(arc, lib.chunkFileName(0)), 0);
  flipByte(path.join(arc, lib.chunkFileName(1)), 0);

  let plan = lib.planRepair(arc, good, 150); // exact fit for both
  assert.deepEqual(plan.repairs.map((r) => r.index), [0, 1]);
  assert.equal(plan.totalBytes, 150);

  plan = lib.planRepair(arc, good, 149); // one byte short: only prefix
  assert.deepEqual(plan.repairs.map((r) => r.index), [0]);
  assert.equal(plan.totalBytes, 100);

  plan = lib.planRepair(arc, good, 100); // exact fit for first
  assert.deepEqual(plan.repairs.map((r) => r.index), [0]);

  plan = lib.planRepair(arc, good, 99); // one byte short: nothing fits
  assert.deepEqual(plan.repairs, []);
  assert.equal(plan.totalBytes, 0);

  assert.throws(() => lib.planRepair(arc, good, -1), { code: 'ERR_BUDGET' });
  assert.throws(() => lib.planRepair(arc, good, 'abc'), { code: 'ERR_BUDGET' });
});

// Deterministic output: identical plans across runs, sorted by chunk index.
test('planRepair: deterministic JSON sorted by chunk index', () => {
  const arc = tmpdir();
  const good = tmpdir();
  const chunks = [buf(1, 10), buf(2, 10), buf(3, 10), buf(4, 10)];
  lib.createArchive(arc, chunks);
  lib.createArchive(good, chunks);
  flipByte(path.join(arc, lib.chunkFileName(1)), 0);
  flipByte(path.join(arc, lib.chunkFileName(3)), 0);
  const a = JSON.stringify(lib.planRepair(arc, good, 1000));
  const b = JSON.stringify(lib.planRepair(arc, good, 1000));
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(a).repairs.map((r) => r.index), [1, 3]);
});

// Acceptance 3: two candidate sources, same claimed hash, different content.
test('planRepair: conflicting sources raise ERR_SOURCE', () => {
  const arc = tmpdir();
  const good = tmpdir();
  const wanted = buf(7, 32);
  lib.createArchive(arc, [wanted]);
  lib.createArchive(good, [wanted, buf(9, 32)]);
  flipByte(path.join(arc, lib.chunkFileName(0)), 0);

  // Make the second good chunk claim the same hash as the first.
  const mp = path.join(good, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.chunks[1].sha256 = m.chunks[0].sha256;
  m.chunks[1].adler32 = m.chunks[0].adler32;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');

  assert.throws(() => lib.planRepair(arc, good, 1024), { code: 'ERR_SOURCE' });
});

// Acceptance 4: injected write failure mid-apply rolls back atomically.
test('applyPlan: injected failure leaves archive byte-identical', () => {
  const arc = tmpdir();
  const good = tmpdir();
  const chunks = [buf(1, 64), buf(2, 64), buf(3, 64)];
  lib.createArchive(arc, chunks);
  lib.createArchive(good, chunks);
  flipByte(path.join(arc, lib.chunkFileName(0)), 0);
  flipByte(path.join(arc, lib.chunkFileName(1)), 0);
  const before = snapshotDir(arc);

  const plan = lib.planRepair(arc, good, 10000);
  assert.equal(plan.repairs.length, 2);

  assert.throws(
    () => lib.applyPlan(arc, plan, {
      onBeforeCommit: (i) => { if (i === 1) throw new Error('injected write failure'); },
    }),
    { code: 'ERR_IO' },
  );
  assertDirEquals(before, arc); // fully rolled back, no temp files left

  const result = lib.applyPlan(arc, plan); // succeeds without injection
  assert.deepEqual(result.applied, [0, 1]);
  assert.equal(lib.verify(arc).ok, true);
});

// Acceptance 5: no corruption -> empty plan.
test('planRepair: intact archive yields empty plan', () => {
  const arc = tmpdir();
  const good = tmpdir();
  const chunks = [buf(1, 32), buf(2, 32)];
  lib.createArchive(arc, chunks);
  lib.createArchive(good, chunks);
  const plan = lib.planRepair(arc, good, 1024);
  assert.deepEqual(plan.repairs, []);
  assert.equal(plan.totalBytes, 0);
  assert.equal(lib.verify(arc).ok, true);
});

test('inspect: broken manifest raises ERR_CRC, missing dir raises ERR_IO', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'manifest.json'), 'not json{');
  assert.throws(() => lib.inspect(dir), { code: 'ERR_CRC' });
  assert.throws(() => lib.inspect(path.join(dir, 'nope')), { code: 'ERR_IO' });
});

test('applyPlan: source content mismatch raises ERR_SOURCE before touching archive', () => {
  const arc = tmpdir();
  const good = tmpdir();
  const chunks = [buf(1, 32)];
  lib.createArchive(arc, chunks);
  lib.createArchive(good, chunks);
  flipByte(path.join(arc, lib.chunkFileName(0)), 0);
  const before = snapshotDir(arc);
  const plan = lib.planRepair(arc, good, 1024);
  flipByte(plan.repairs[0].source, 0); // corrupt the source after planning
  assert.throws(() => lib.applyPlan(arc, plan), { code: 'ERR_SOURCE' });
  assertDirEquals(before, arc);
});

function runCli(...argv) {
  let stdout = '';
  let stderr = '';
  const status = cli.run(argv, {
    writeStdout: (s) => { stdout += s; },
    writeStderr: (s) => { stderr += s; },
  });
  return { status, stdout, stderr };
}

// CLI end-to-end: node cli.js planRepair arc good 1024
test('cli: planRepair / applyPlan / verify round trip', () => {
  const arc = tmpdir();
  const good = tmpdir();
  const chunks = [buf(1, 40), buf(2, 40)];
  lib.createArchive(arc, chunks);
  lib.createArchive(good, chunks);
  flipByte(path.join(arc, lib.chunkFileName(1)), 0);

  const r1 = runCli('planRepair', arc, good, '1024');
  assert.equal(r1.status, 0);
  const plan = JSON.parse(r1.stdout);
  assert.deepEqual(plan.repairs.map((r) => r.index), [1]);
  assert.equal(plan.totalBytes, 40);

  const planFile = path.join(tmpdir(), 'plan.json');
  fs.writeFileSync(planFile, r1.stdout);
  assert.equal(runCli('applyPlan', arc, planFile).status, 0);

  const r2 = runCli('verify', arc);
  assert.equal(r2.status, 0);
  const v = JSON.parse(r2.stdout);
  assert.equal(v.ok, true);
});

test('cli: errors are JSON on stderr with non-zero exit', () => {
  const arc = tmpdir();
  const good = tmpdir();
  lib.createArchive(arc, [buf(1, 8)]);
  lib.createArchive(good, [buf(1, 8)]);

  const r = runCli('planRepair', arc, good, '-5');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error, 'ERR_BUDGET');

  const r2 = runCli('inspect', path.join(arc, 'missing'));
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stderr).error, 'ERR_IO');
});
