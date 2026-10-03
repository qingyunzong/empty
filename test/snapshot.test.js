'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const cli = require('../cli');

const CLI = path.join(__dirname, '..', 'cli.js');

function runCli(argv, env = {}) {
  const out = [];
  const err = [];
  const code = cli.main(argv, env, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function readTree(root) {
  const out = {};
  (function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else if (ent.isFile()) out[r] = fs.readFileSync(path.join(dir, ent.name), 'utf8');
    }
  })(root, '');
  delete out['.snapshot.json'];
  return out;
}

function repoFingerprint(repo) {
  const fp = {};
  fp.head = store.readHead(repo);
  fp.verify = store.verify(repo);
  fp.tmp = fs.readdirSync(path.join(repo, 'chunks', 'tmp'));
  fp.pending = fs.existsSync(path.join(repo, 'log', 'pending.json'));
  fp.indexFiles = fs.readdirSync(path.join(repo, 'index')).sort();
  return fp;
}

function bigContent(seed, kb) {
  let s = '';
  let x = seed;
  while (s.length < kb * 1024) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += x.toString(36) + ':' + (x % 997) + '\n';
  }
  return s;
}

// Acceptance 1: injecting any of the three crash classes yields a
// deterministic rollback to the last commit point after resume.
test('fault injection: three crash classes recover deterministically', () => {
  const faults = ['chunk-partial', 'log-no-commit', 'index-no-fsync'];
  for (const type of faults) {
    const runs = [];
    for (let run = 0; run < 2; run++) {
      const dir = tmpdir();
      const repo = path.join(dir, 'repo');
      const src = path.join(dir, 'src');
      fs.mkdirSync(src, { recursive: true });

      writeTree(src, { 'a.txt': bigContent(7, 40), 'sub/b.txt': 'hello v1' });
      const v1 = store.writeSnapshot(repo, src).version;

      writeTree(src, { 'a.txt': bigContent(99, 40), 'c.txt': 'new file' });
      assert.throws(
        () => store.writeSnapshot(repo, src, { fault: { type } }),
        (e) => e.code === 'ERR_CRASH'
      );

      const res = store.resume(repo);
      assert.equal(res.version, v1, type + ': must roll back to last commit');
      if (type === 'chunk-partial') {
        // crash before the log phase: temp chunk cleaned, nothing to roll back
        assert.equal(res.rolledBack, false);
        assert.deepEqual(fs.readdirSync(path.join(repo, 'chunks', 'tmp')), []);
      } else {
        assert.equal(res.rolledBack, true, type + ': pending log must be rolled back');
      }

      const out = path.join(dir, 'out');
      store.materialize(repo, v1, out);
      assert.deepEqual(readTree(out), {
        'a.txt': bigContent(7, 40),
        'sub/b.txt': 'hello v1',
      });

      runs.push(repoFingerprint(repo));
    }
    assert.deepEqual(runs[0], runs[1], type + ': repeated runs must be identical');
  }
});

// Acceptance 2: enumerate all ordered version pairs and cross-check diff
// against an independently computed expectation.
test('diff: all pairs of versions match independent expectation', () => {
  const dir = tmpdir();
  const repo = path.join(dir, 'repo');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });

  const versions = [];
  const trees = [
    { 'a.txt': 'one', 'b/c.txt': 'see', 'd.txt': 'dee' },
    { 'a.txt': 'one-modified', 'b/c.txt': 'see' },
    { 'a.txt': 'one-modified', 'b/c.txt': 'see v3', 'e/f.txt': 'eff' },
    { 'z.txt': 'last' },
  ];
  for (const files of trees) {
    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });
    writeTree(src, files);
    versions.push(store.writeSnapshot(repo, src).version);
  }

  const digestOf = (content) => content; // expectation uses content equality
  for (let i = 0; i < versions.length; i++) {
    for (let j = 0; j < versions.length; j++) {
      const expected = [];
      const ta = trees[i];
      const tb = trees[j];
      for (const p of Object.keys(tb)) {
        if (!(p in ta)) expected.push({ op: 'A', path: p });
        else if (digestOf(ta[p]) !== digestOf(tb[p])) expected.push({ op: 'M', path: p });
      }
      for (const p of Object.keys(ta)) {
        if (!(p in tb)) expected.push({ op: 'D', path: p });
      }
      expected.sort((x, y) => store.comparePaths(x.path, y.path));

      const got = store.diff(repo, versions[i], versions[j]);
      assert.deepEqual(got, expected, `diff(v${i}, v${j})`);

      const sorted = got.slice().sort((x, y) => store.comparePaths(x.path, y.path));
      assert.deepEqual(got, sorted, 'diff output must be sorted by canonical path bytes');
    }
  }

  assert.throws(() => store.diff(repo, versions[0], 'deadbeefdeadbeef'),
    (e) => e.code === 'ERR_VERSION');
});

// Acceptance 3: corrupting an unreferenced old chunk does not affect
// materialize but verify reports ERR_CHUNK.
test('corrupt unreferenced chunk: materialize ok, verify ERR_CHUNK', () => {
  const dir = tmpdir();
  const repo = path.join(dir, 'repo');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });

  writeTree(src, { 'old.txt': bigContent(3, 30) });
  const v1 = store.writeSnapshot(repo, src).version;

  writeTree(src, { 'new.txt': bigContent(8, 30) });
  fs.rmSync(path.join(src, 'old.txt'));
  const v2 = store.writeSnapshot(repo, src).version;

  const m1 = JSON.parse(fs.readFileSync(path.join(repo, 'index', v1 + '.json'), 'utf8'));
  const m2 = JSON.parse(fs.readFileSync(path.join(repo, 'index', v2 + '.json'), 'utf8'));
  const inV2 = new Set(m2.manifest.files.flatMap((f) => f.chunks.map((c) => c.sha256)));
  const stale = m1.manifest.files.flatMap((f) => f.chunks.map((c) => c.sha256))
    .find((s) => !inV2.has(s));
  assert.ok(stale, 'expected an unreferenced old chunk');

  const chunkFile = path.join(repo, 'chunks', stale);
  const data = fs.readFileSync(chunkFile);
  data[0] ^= 0xff;
  fs.writeFileSync(chunkFile, data);

  const out = path.join(dir, 'out');
  const res = store.materialize(repo, v2, out);
  assert.equal(res.version, v2);
  assert.deepEqual(readTree(out), { 'new.txt': bigContent(8, 30) });

  assert.throws(() => store.verify(repo), (e) => e.code === 'ERR_CHUNK');
});

// Acceptance 4: empty snapshots and duplicate snapshots are idempotent.
test('empty and duplicate snapshots are idempotent', () => {
  const dir = tmpdir();
  const repo = path.join(dir, 'repo');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });

  const e1 = store.writeSnapshot(repo, src);
  assert.equal(e1.committed, true);
  const headAfterEmpty = store.readHead(repo);
  const e2 = store.writeSnapshot(repo, src);
  assert.equal(e2.version, e1.version);
  assert.equal(e2.unchanged, true);
  assert.equal(store.readHead(repo), headAfterEmpty);
  assert.equal(store.listVersions(repo).length, 1);

  const out = path.join(dir, 'out');
  const m = store.materialize(repo, e1.version, out);
  assert.equal(m.files, 0);
  assert.deepEqual(readTree(out), {});

  writeTree(src, { 'x.txt': 'content-x' });
  const s1 = store.writeSnapshot(repo, src);
  assert.equal(s1.committed, true);
  const headAfter = store.readHead(repo);
  const s2 = store.writeSnapshot(repo, src);
  assert.equal(s2.version, s1.version);
  assert.equal(s2.unchanged, true);
  assert.equal(s2.committed, false);
  assert.equal(store.readHead(repo), headAfter);
  assert.equal(store.listVersions(repo).length, 2);
  assert.deepEqual(store.verify(repo).ok, true);
});

// Incremental materialize reads only changed chunks.
test('incremental materialize rewrites only changed files', () => {
  const dir = tmpdir();
  const repo = path.join(dir, 'repo');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });

  writeTree(src, { 'keep.txt': 'keep me', 'chg.txt': 'before', 'gone.txt': 'x' });
  const v1 = store.writeSnapshot(repo, src).version;
  const out = path.join(dir, 'out');
  store.materialize(repo, v1, out);

  writeTree(src, { 'chg.txt': 'after' });
  fs.rmSync(path.join(src, 'gone.txt'));
  const v2 = store.writeSnapshot(repo, src).version;
  const res = store.materialize(repo, v2, out);
  assert.equal(res.rewritten, 1);
  assert.deepEqual(readTree(out), { 'keep.txt': 'keep me', 'chg.txt': 'after' });
});

// Dirty repo: a pending log blocks new snapshots until resume.
test('ERR_DIRTY when writing over an uncommitted log', () => {
  const dir = tmpdir();
  const repo = path.join(dir, 'repo');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  writeTree(src, { 'f.txt': 'v1' });
  store.writeSnapshot(repo, src);
  writeTree(src, { 'f.txt': 'v2' });
  assert.throws(() => store.writeSnapshot(repo, src, { fault: { type: 'log-no-commit' } }),
    (e) => e.code === 'ERR_CRASH');
  assert.throws(() => store.writeSnapshot(repo, src), (e) => e.code === 'ERR_DIRTY');
  store.resume(repo);
  const r = store.writeSnapshot(repo, src);
  assert.equal(r.committed, true);
});

// CLI end-to-end: fault via env, JSON error on stderr, resume, verify, diff.
test('CLI: write fault, resume, verify, diff, materialize', () => {
  const dir = tmpdir();
  const repo = path.join(dir, 'repo');
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  writeTree(src, { 'a.txt': 'alpha' });

  const w1 = JSON.parse(runCli(['write', repo, src]).stdout);
  assert.equal(w1.committed, true);

  writeTree(src, { 'a.txt': 'beta', 'b.txt': 'new' });
  const crashed = runCli(['write', repo, src], { SNAP_FAULT: 'log-no-commit' });
  assert.equal(crashed.code, 1);
  const errObj = JSON.parse(crashed.stderr.trim());
  assert.equal(errObj.error, 'ERR_CRASH');

  const resumed = JSON.parse(runCli(['resume', repo]).stdout);
  assert.equal(resumed.version, w1.version);
  assert.equal(resumed.rolledBack, true);

  const w2 = JSON.parse(runCli(['write', repo, src]).stdout);
  const verified = JSON.parse(runCli(['verify', repo]).stdout);
  assert.equal(verified.ok, true);
  assert.equal(verified.version, w2.version);

  const diffOut = runCli(['diff', repo, w1.version, w2.version]).stdout;
  assert.deepEqual(diffOut.trim().split('\n'), ['M a.txt', 'A b.txt'].sort((x, y) =>
    store.comparePaths(x.slice(2), y.slice(2))));

  const out = path.join(dir, 'out');
  const mat = JSON.parse(runCli(['materialize', repo, w1.version, out]).stdout);
  assert.equal(mat.version, w1.version);
  assert.deepEqual(readTree(out), { 'a.txt': 'alpha' });

  const badDiff = runCli(['diff', repo, w1.version, 'nope']);
  assert.equal(badDiff.code, 1);
  assert.equal(JSON.parse(badDiff.stderr.trim()).error, 'ERR_VERSION');
});
