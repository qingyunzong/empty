'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Writer, paths: dbPaths } = require('../src/writer');
const { Decoder, verifyCertificateFile } = require('../src/decoder');
const { QlinError } = require('../src/errors');

function tmpBase(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlin-'));
  return path.join(dir, name);
}

// Seeded PRNG (mulberry32) for reproducible random graphs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDb(base, records, blockRecords = 3) {
  const w = Writer.init(base, { blockRecords });
  for (const r of records) w.add(r);
  w.seal();
}

// Independent reference: all simple paths child->parent via plain DFS.
function refPaths(records, from, to) {
  const parents = new Map(records.map((r) => [r.lot, r.parents]));
  const out = [];
  const stack = [from];
  const onPath = new Set([from]);
  const dfs = (node) => {
    if (node === to) { out.push([...stack]); return; }
    for (const p of parents.get(node) || []) {
      if (onPath.has(p)) continue;
      onPath.add(p); stack.push(p);
      dfs(p);
      stack.pop(); onPath.delete(p);
    }
  };
  dfs(from);
  return out;
}

function refReachable(records, from, forward) {
  const adj = new Map();
  for (const r of records) {
    if (forward) {
      adj.set(r.lot, r.parents);
    } else {
      for (const p of r.parents) {
        if (!adj.has(p)) adj.set(p, []);
        adj.get(p).push(r.lot);
      }
      if (!adj.has(r.lot)) adj.set(r.lot, []);
    }
  }
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const n = queue.shift();
    for (const m of adj.get(n) || []) {
      if (!seen.has(m)) { seen.add(m); queue.push(m); }
    }
  }
  return seen;
}

const norm = (paths) => paths.map((p) => p.join('>')).sort();

test('random DAGs (<=10 lots): paths/ancestors/descendants match independent DFS', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rand = rng(seed);
    const n = 2 + Math.floor(rand() * 9); // 2..10 lots
    const records = [];
    for (let i = 0; i < n; i++) {
      const parents = [];
      for (let j = 0; j < i; j++) {
        if (rand() < 0.35) parents.push(`L${j}`);
      }
      records.push({ lot: `L${i}`, parents, op: `op${i}`, verdict: rand() < 0.8 ? 'pass' : 'fail' });
    }
    const base = tmpBase('db');
    buildDb(base, records, 1 + Math.floor(rand() * 3)); // 1..3 records per block

    const d = new Decoder(base);
    try {
      for (let from = 0; from < n; from++) {
        for (let to = 0; to < n; to++) {
          const got = norm(d.paths(`L${from}`, `L${to}`).map((c) => c.path));
          const want = norm(refPaths(records, `L${from}`, `L${to}`));
          assert.deepEqual(got, want, `seed=${seed} from=L${from} to=L${to}`);
        }
        assert.deepEqual(
          new Set(d.ancestors(`L${from}`).lots),
          refReachable(records, `L${from}`, true),
        );
        assert.deepEqual(
          new Set(d.descendants(`L${from}`).lots),
          refReachable(records, `L${from}`, false),
        );
      }
    } finally {
      d.close();
    }
  }
});

test('certificates re-verify and contain block ids, record offsets, boundary hashes', () => {
  const base = tmpBase('db');
  const records = [
    { lot: 'A', parents: [], op: 'receive', verdict: 'pass' },
    { lot: 'B', parents: [], op: 'receive', verdict: 'pass' },
    { lot: 'C', parents: ['A', 'B'], op: 'mix', verdict: 'pass' },
    { lot: 'D', parents: ['C'], op: 'bake', verdict: 'fail' },
  ];
  buildDb(base, records, 2);

  const d = new Decoder(base);
  try {
    const certs = d.paths('D', 'A');
    assert.equal(certs.length, 1);
    const cert = certs[0];
    assert.deepEqual(cert.path, ['D', 'C', 'A']);
    assert.ok(cert.blocks.length >= 2, 'cert spans multiple blocks');
    for (const b of cert.blocks) {
      assert.ok(Number.isInteger(b.id));
      assert.match(b.sha256, /^[0-9a-f]{64}$/);
    }
    for (const r of cert.records) {
      assert.ok(Number.isInteger(r.offset) && r.offset > 0);
      assert.ok(Number.isInteger(r.length) && r.length > 0);
    }
    assert.equal(d.verifyCertificate(cert), true);
    assert.equal(verifyCertificateFile(base, cert), true);
    const anc = d.ancestors('D');
    assert.equal(d.verifyCertificate(anc.proof), true);
  } finally {
    d.close();
  }
});

test('single corrupted block: isolation is exact, touching queries get E_CRC', () => {
  const base = tmpBase('db');
  // Two independent chains; blockRecords=2 -> block0:[A0,A1] block1:[A2,A3] block2:[B0,B1] block3:[B2,B3]
  const records = [
    { lot: 'A0', parents: [] }, { lot: 'A1', parents: ['A0'] },
    { lot: 'A2', parents: ['A1'] }, { lot: 'A3', parents: ['A2'] },
    { lot: 'B0', parents: [] }, { lot: 'B1', parents: ['B0'] },
    { lot: 'B2', parents: ['B1'] }, { lot: 'B3', parents: ['B2'] },
  ];
  buildDb(base, records, 2);

  const manifest = JSON.parse(fs.readFileSync(dbPaths(base).manifest, 'utf8'));
  assert.equal(manifest.blocks.length, 4);

  // Baseline before corruption.
  const before = new Decoder(base);
  const baselineB = norm(before.paths('B3', 'B0').map((c) => c.path));
  const baselineA1 = norm(before.paths('A1', 'A0').map((c) => c.path));
  before.close();

  // Flip one byte inside block 1's payload.
  const entry = manifest.blocks[1];
  const fd = fs.openSync(dbPaths(base).data, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, entry.offset + 10);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, entry.offset + 10);
  fs.closeSync(fd);

  const d = new Decoder(base);
  try {
    // Untouched chain B fully queryable.
    assert.deepEqual(norm(d.paths('B3', 'B0').map((c) => c.path)), baselineB);
    assert.deepEqual(new Set(d.ancestors('B3').lots), new Set(['B3', 'B2', 'B1', 'B0']));
    assert.deepEqual(new Set(d.descendants('B0').lots), new Set(['B0', 'B1', 'B2', 'B3']));
    // Untouched prefix of chain A (block 0) still queryable: isolation is exact.
    assert.deepEqual(norm(d.paths('A1', 'A0').map((c) => c.path)), baselineA1);
    assert.deepEqual(new Set(d.ancestors('A1').lots), new Set(['A1', 'A0']));
    // Anything requiring corrupt block 1 fails with E_CRC, no guessed paths.
    for (const fn of [
      () => d.paths('A3', 'A0'),
      () => d.paths('A2', 'A0'),
      () => d.ancestors('A3'),
      () => d.ancestors('A2'),
      () => d.descendants('A0'),
      () => d.descendants('A1'),
    ]) {
      assert.throws(fn, (err) => err instanceof QlinError && err.code === 'E_CRC');
    }
  } finally {
    d.close();
  }
});

test('append block + atomic manifest update: old certs re-verify, new certs include new block', () => {
  const base = tmpBase('db');
  buildDb(base, [
    { lot: 'A', parents: [] }, { lot: 'B', parents: ['A'] },
    { lot: 'C', parents: ['B'] }, { lot: 'D', parents: ['C'] },
  ], 2);

  const d1 = new Decoder(base);
  const oldCerts = d1.paths('D', 'A');
  assert.equal(oldCerts.length, 1);
  const oldBlockIds = oldCerts[0].blocks.map((b) => b.id);
  d1.close();

  const manifestBefore = JSON.parse(fs.readFileSync(dbPaths(base).manifest, 'utf8'));
  assert.equal(manifestBefore.blocks.length, 2);

  // Append a new block and atomically update the manifest.
  const w = new Writer(base);
  w.add({ lot: 'E', parents: ['D'], op: 'ship', verdict: 'pass' });
  w.add({ lot: 'F', parents: ['E'], op: 'ship', verdict: 'pass' });
  w.seal();

  const manifestAfter = JSON.parse(fs.readFileSync(dbPaths(base).manifest, 'utf8'));
  assert.equal(manifestAfter.blocks.length, 3);
  // Old block hashes unchanged by the append.
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(manifestAfter.blocks[i], manifestBefore.blocks[i]);
  }

  // Old certificates still re-verify against the updated manifest.
  assert.equal(verifyCertificateFile(base, oldCerts[0]), true);

  const d2 = new Decoder(base);
  try {
    const newCerts = d2.paths('F', 'A');
    assert.equal(newCerts.length, 1);
    const newBlockIds = newCerts[0].blocks.map((b) => b.id);
    assert.ok(newBlockIds.includes(2), 'new certificate includes appended block');
    for (const id of oldBlockIds) assert.ok(newBlockIds.includes(id));
    assert.equal(d2.verifyCertificate(newCerts[0]), true);
  } finally {
    d2.close();
  }
});

test('index/manifest inconsistency returns E_INDEX', () => {
  // Case 1: index references a block the manifest does not have.
  const base1 = tmpBase('db');
  buildDb(base1, [{ lot: 'A', parents: [] }, { lot: 'B', parents: ['A'] }], 2);
  const idx1 = JSON.parse(fs.readFileSync(dbPaths(base1).index, 'utf8'));
  idx1.lots.A.block = 7;
  fs.writeFileSync(dbPaths(base1).index, JSON.stringify(idx1, null, 2));
  assert.throws(() => new Decoder(base1), (e) => e.code === 'E_INDEX');

  // Case 2: index offset does not match block contents.
  const base2 = tmpBase('db');
  buildDb(base2, [{ lot: 'A', parents: [] }, { lot: 'B', parents: ['A'] }], 2);
  const idx2 = JSON.parse(fs.readFileSync(dbPaths(base2).index, 'utf8'));
  idx2.lots.B.offset = idx2.lots.A.offset; // point B at A's record
  fs.writeFileSync(dbPaths(base2).index, JSON.stringify(idx2, null, 2));
  const d = new Decoder(base2); // construction ok: range still inside block
  try {
    assert.throws(() => d.ancestors('B'), (e) => e.code === 'E_INDEX');
  } finally {
    d.close();
  }
});

test('tampered certificates fail verification', () => {
  const base = tmpBase('db');
  buildDb(base, [
    { lot: 'A', parents: [] }, { lot: 'B', parents: ['A'] }, { lot: 'C', parents: ['B'] },
  ], 2);
  const d = new Decoder(base);
  try {
    const cert = d.paths('C', 'A')[0];
    assert.equal(d.verifyCertificate(cert), true);

    const badHash = JSON.parse(JSON.stringify(cert));
    badHash.blocks[0].sha256 = '0'.repeat(64);
    assert.throws(() => d.verifyCertificate(badHash), (e) => e.code === 'E_MANIFEST');

    const badPath = JSON.parse(JSON.stringify(cert));
    badPath.path = ['C', 'A'];
    assert.throws(() => d.verifyCertificate(badPath), (e) => e.code === 'E_CERT');

    const badOffset = JSON.parse(JSON.stringify(cert));
    badOffset.records[1].offset += 1;
    assert.throws(() => d.verifyCertificate(badOffset), (e) => e.code === 'E_CERT');
  } finally {
    d.close();
  }
});

test('CLI end-to-end: init/add/seal/paths/verify, E_CRC exit code', () => {
  const base = tmpBase('db');
  const { run } = require('../cli.js');
  const runCli = (args) => {
    const out = [];
    const err = [];
    const code = run(args, (s) => out.push(s), (s) => err.push(s));
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  };

  assert.equal(runCli(['init', base, '--block-records', '2']).code, 0);
  runCli(['add', base, '--lot', 'A', '--op', 'receive', '--verdict', 'pass']);
  runCli(['add', base, '--lot', 'B', '--parents', 'A', '--op', 'mix', '--verdict', 'pass']);
  runCli(['add', base, '--lot', 'C', '--parents', 'B', '--op', 'bake', '--verdict', 'fail']);
  assert.equal(runCli(['seal', base]).code, 0);

  const certs = JSON.parse(runCli(['paths', base, 'C', 'A']).stdout);
  assert.equal(certs.length, 1);
  assert.deepEqual(certs[0].path, ['C', 'B', 'A']);

  const certFile = base + '.cert.json';
  fs.writeFileSync(certFile, JSON.stringify(certs[0], null, 2));
  assert.match(runCli(['verify', base, certFile]).stdout, /certificate OK/);

  const anc = JSON.parse(runCli(['ancestors', base, 'C']).stdout);
  assert.deepEqual(new Set(anc.lots), new Set(['C', 'B', 'A']));

  // Corrupt the only block; CLI must exit non-zero with E_CRC.
  const manifest = JSON.parse(fs.readFileSync(dbPaths(base).manifest, 'utf8'));
  const fd = fs.openSync(dbPaths(base).data, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, manifest.blocks[0].offset + 9);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, manifest.blocks[0].offset + 9);
  fs.closeSync(fd);

  const bad = runCli(['paths', base, 'C', 'A']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /E_CRC/);
});
