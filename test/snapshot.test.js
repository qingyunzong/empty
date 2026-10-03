'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const snap = require('../snapshot.js');

const SMALL = { min: 64, avg: 256, max: 1024 };

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'snap-')); }

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function readTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rp);
      else if (e.isFile() && e.name !== snap.STATE_FILE) out[rp] = fs.readFileSync(path.join(dir, e.name), 'utf8');
    }
  };
  walk(root, '');
  return out;
}

function deterministicContent(seed, n) {
  let s = seed >>> 0;
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    buf[i] = 97 + (s % 26);
  }
  return buf;
}

function repoFingerprint(repo) {
  const idx = fs.readFileSync(path.join(repo, 'index.json'), 'utf8');
  const chunkDir = path.join(repo, 'chunks');
  const chunks = fs.readdirSync(chunkDir).sort().map((n) => n + ':' + snap.sha256hex(fs.readFileSync(path.join(chunkDir, n))));
  return JSON.stringify({ idx, chunks });
}

// ---------- acceptance 1: three crash classes recover deterministically ----------
for (const fault of ['chunk-partial', 'journal-uncommitted', 'index-no-fsync']) {
  test(`fault ${fault}: resume returns to last commit, temp blocks cleaned, results deterministic`, () => {
    const fingerprints = [];
    for (let run = 0; run < 2; run++) {
      const repo = tmpdir();
      const src = tmpdir();
      writeFiles(src, { 'a.txt': deterministicContent(1, 3000), 'b.txt': deterministicContent(2, 1500) });
      const r1 = snap.writeSnapshot(repo, src, { params: SMALL });
      assert.deepEqual({ version: r1.version, created: r1.created }, { version: 1, created: true });

      writeFiles(src, { 'a.txt': deterministicContent(99, 3000), 'c.txt': deterministicContent(3, 800) });
      assert.throws(() => snap.writeSnapshot(repo, src, { fault }), snap.SimulatedCrash);

      // dirty repo: reads refuse until resume
      assert.throws(() => snap.verify(repo), (e) => e.code === 'ERR_DIRTY');
      assert.throws(() => snap.diff(repo, 1, 1), (e) => e.code === 'ERR_DIRTY');

      const rec = snap.resume(repo);
      assert.equal(rec.status, 'recovered');
      assert.equal(rec.version, 1, 'back to last commit point');
      if (fault === 'chunk-partial') assert.ok(rec.removedTempChunks >= 1, 'temp block cleaned');
      if (fault === 'journal-uncommitted') assert.equal(rec.discardedVersion, 2);

      // no leftover uncommitted state
      assert.ok(!fs.existsSync(path.join(repo, 'JOURNAL')));
      assert.ok(!fs.existsSync(path.join(repo, 'index.json.tmp')));
      assert.deepEqual(fs.readdirSync(path.join(repo, 'tmp')), []);

      assert.deepEqual(snap.verify(repo).ok, true);
      const r2 = snap.writeSnapshot(repo, src);
      assert.deepEqual({ version: r2.version, created: r2.created }, { version: 2, created: true });
      assert.deepEqual(snap.verify(repo).ok, true);

      const dest = tmpdir();
      snap.materialize(repo, 2, dest);
      assert.deepEqual(readTree(dest), readTree(src));
      fingerprints.push(repoFingerprint(repo));
    }
    assert.deepEqual(fingerprints[0], fingerprints[1], 'same fault scenario -> identical repo bytes');
  });
}

test('resume on clean repo is a no-op', () => {
  const repo = tmpdir();
  const src = tmpdir();
  writeFiles(src, { 'x.txt': 'hello' });
  snap.writeSnapshot(repo, src);
  const rec = snap.resume(repo);
  assert.deepEqual(rec, { status: 'clean', version: 1 });
});

// ---------- acceptance 2: exhaustive pairwise diff on a small directory ----------
test('diff matches independently computed deltas for all version pairs, sorted by byte order', () => {
  const repo = tmpdir();
  const src = tmpdir();
  const states = [
    { 'a.txt': 'alpha', 'b.txt': 'beta', 'sub/c.txt': 'gamma' },
    { 'a.txt': 'ALPHA2', 'd.txt': 'delta', 'sub/c.txt': 'gamma' },
    { 'a.txt': 'ALPHA2', 'd.txt': 'DELTA3', 'sub/d.txt': 'gamma' },
    { 'a.txt': 'alpha', 'b.txt': 'beta', 'sub/c.txt': 'gamma' },
  ];
  const ids = [];
  for (const st of states) {
    for (const name of fs.readdirSync(src)) fs.rmSync(path.join(src, name), { recursive: true });
    writeFiles(src, st);
    ids.push(snap.writeSnapshot(repo, src).version);
  }
  assert.deepEqual(ids, [1, 2, 3, 4]);

  const sha = (s) => snap.sha256hex(Buffer.from(s, 'utf8'));
  const byBytes = (x, y) => Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
  for (let i = 0; i < states.length; i++) {
    for (let j = 0; j < states.length; j++) {
      if (i === j) continue;
      const expected = [];
      for (const [p, c] of Object.entries(states[j])) {
        if (!(p in states[i])) expected.push({ op: 'added', path: p });
        else if (sha(states[i][p]) !== sha(c)) expected.push({ op: 'modified', path: p });
      }
      for (const p of Object.keys(states[i])) {
        if (!(p in states[j])) expected.push({ op: 'removed', path: p });
      }
      expected.sort((x, y) => byBytes(x.path, y.path));
      assert.deepEqual(snap.diff(repo, ids[i], ids[j]), expected, `diff(${ids[i]},${ids[j]})`);
    }
  }
  // identical versions -> empty diff
  assert.deepEqual(snap.diff(repo, 1, 4), []);
  // unknown version -> ERR_VERSION
  assert.throws(() => snap.diff(repo, 1, 99), (e) => e.code === 'ERR_VERSION');
});

// ---------- acceptance 3: corrupting an unreferenced old block ----------
test('corrupt unreferenced old chunk: materialize unaffected, verify reports ERR_CHUNK', () => {
  const repo = tmpdir();
  const src = tmpdir();
  writeFiles(src, { 'big.txt': deterministicContent(7, 4000) });
  snap.writeSnapshot(repo, src, { params: SMALL });
  const v1Chunks = JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8')).versions[0].files[0].chunks.map((c) => c.sha256);

  writeFiles(src, { 'big.txt': deterministicContent(8, 4000) });
  snap.writeSnapshot(repo, src);
  const v2Chunks = new Set(JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8')).versions[1].files[0].chunks.map((c) => c.sha256));
  const oldOnly = v1Chunks.filter((c) => !v2Chunks.has(c));
  assert.ok(oldOnly.length > 0, 'v1 has chunks not referenced by v2');

  const dest = tmpdir();
  snap.materialize(repo, 2, dest);
  assert.deepEqual(readTree(dest), readTree(src));

  // corrupt one chunk referenced only by the old version
  const victim = path.join(repo, 'chunks', oldOnly[0]);
  const data = fs.readFileSync(victim);
  data[0] ^= 0xff;
  fs.writeFileSync(victim, data);

  const dest2 = tmpdir();
  const stats = snap.materialize(repo, 2, dest2);
  assert.equal(stats.filesWritten, 1);
  assert.deepEqual(readTree(dest2), readTree(src), 'materialize(v2) unaffected');

  assert.throws(() => snap.verify(repo), (e) => e.code === 'ERR_CHUNK');
  assert.throws(() => snap.verify(repo, 1), (e) => e.code === 'ERR_CHUNK');
  assert.throws(() => snap.materialize(repo, 1, tmpdir()), (e) => e.code === 'ERR_CHUNK');
});

// ---------- acceptance 4: empty snapshot and duplicate snapshot idempotency ----------
test('empty snapshot and repeated snapshots are idempotent', () => {
  const repo = tmpdir();
  const src = tmpdir();

  const e1 = snap.writeSnapshot(repo, src);
  assert.deepEqual({ version: e1.version, created: e1.created }, { version: 1, created: true });
  const e2 = snap.writeSnapshot(repo, src);
  assert.deepEqual({ version: e2.version, created: e2.created }, { version: 1, created: false });
  const idx = JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8'));
  assert.equal(idx.versions.length, 1, 'no duplicate version recorded');
  assert.deepEqual(snap.verify(repo), { ok: true, chunks: 0, versions: 1 });

  const dest = tmpdir();
  const stats = snap.materialize(repo, 1, dest);
  assert.deepEqual(readTree(dest), {});
  assert.equal(stats.filesWritten, 0);
  assert.deepEqual(snap.diff(repo, 1, 1), []);

  writeFiles(src, { 'f.txt': 'content' });
  const n1 = snap.writeSnapshot(repo, src);
  assert.deepEqual({ version: n1.version, created: n1.created }, { version: 2, created: true });
  const n2 = snap.writeSnapshot(repo, src);
  assert.deepEqual({ version: n2.version, created: n2.created }, { version: 2, created: false });
  const idx2 = JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8'));
  assert.equal(idx2.versions.length, 2);

  // back to empty: new version, then idempotent again
  fs.rmSync(path.join(src, 'f.txt'));
  const e3 = snap.writeSnapshot(repo, src);
  assert.deepEqual({ version: e3.version, created: e3.created }, { version: 3, created: true });
  const dest2 = tmpdir();
  snap.materialize(repo, 2, dest2);
  const stats2 = snap.materialize(repo, 3, dest2);
  assert.equal(stats2.filesRemoved, 1);
  assert.deepEqual(readTree(dest2), {});
});

// ---------- incremental decode: only changed chunks are read ----------
test('incremental materialize reads only changed chunks, global checksum covers everything', () => {
  const repo = tmpdir();
  const src = tmpdir();
  writeFiles(src, { 'a.bin': deterministicContent(11, 3000), 'b.bin': deterministicContent(22, 3000) });
  snap.writeSnapshot(repo, src, { params: SMALL });

  const dest = tmpdir();
  const s1 = snap.materialize(repo, 1, dest);
  assert.equal(s1.filesWritten, 2);
  const totalChunks = s1.chunksRead;
  assert.ok(totalChunks > 2, 'content-defined chunking produced multiple chunks');

  writeFiles(src, { 'a.bin': deterministicContent(33, 3000) });
  snap.writeSnapshot(repo, src);
  const idx = JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8'));
  const aChunks = idx.versions[1].files.find((f) => f.path === 'a.bin').chunks.length;

  const s2 = snap.materialize(repo, 2, dest);
  assert.equal(s2.filesReused, 1, 'unchanged file reused without chunk reads');
  assert.equal(s2.filesWritten, 1);
  assert.equal(s2.chunksRead, aChunks, 'only changed file chunks decoded');
  assert.deepEqual(readTree(dest), readTree(src));

  // local edit in dest is detected via global/file checksum and repaired from chunks
  fs.writeFileSync(path.join(dest, 'b.bin'), 'tampered');
  const s3 = snap.materialize(repo, 2, dest);
  assert.equal(s3.filesWritten, 1);
  assert.deepEqual(readTree(dest), readTree(src));
});
