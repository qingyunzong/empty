'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encode, appendRecords, Decoder, verifyCertificate, QGError } = require('../src/index');
const { run: cliRun } = require('../bin/cli');

// ---------------------------------------------------------------- helpers

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-'));
}

function files(dir) {
  return {
    dataPath: path.join(dir, 'data.qg'),
    manifestPath: path.join(dir, 'manifest.json'),
    indexPath: path.join(dir, 'index.json'),
  };
}

const rec = (lot, parents, op = 'op', result = 'pass') => ({ lot, parents, op, result });

// 10-lot DAG used by several tests (edges run child -> parents):
//   L0,L1 roots; L2<-L0; L3<-L0,L1; L4<-L2; L5<-L3,L4;
//   L6<-L5; L7<-L6; L8<-L1; L9<-L8,L7
function dagRecords() {
  return [
    rec('L0', []), rec('L1', []),
    rec('L2', ['L0']), rec('L3', ['L0', 'L1']),
    rec('L4', ['L2']), rec('L5', ['L3', 'L4']),
    rec('L6', ['L5']), rec('L7', ['L6']),
    rec('L8', ['L1']), rec('L9', ['L8', 'L7']),
  ];
}

// Independent reference implementations over the raw records.
function refAncestors(records, lot) {
  const byLot = new Map(records.map((r) => [r.lot, r]));
  const out = new Set();
  const visit = (l) => {
    if (out.has(l)) return;
    out.add(l);
    for (const p of byLot.get(l).parents) visit(p);
  };
  visit(lot);
  return out;
}

function refDescendants(records, lot) {
  const children = new Map();
  for (const r of records) for (const p of r.parents) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(r.lot);
  }
  const out = new Set();
  const visit = (l) => {
    if (out.has(l)) return;
    out.add(l);
    for (const c of children.get(l) || []) visit(c);
  };
  visit(lot);
  return out;
}

function refPaths(records, from, to) {
  const byLot = new Map(records.map((r) => [r.lot, r]));
  const out = [];
  const dfs = (node, acc, seen) => {
    const next = [...acc, node];
    if (node === to) {
      out.push(next);
      return;
    }
    for (const p of byLot.get(node).parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      dfs(p, next, seen);
      seen.delete(p);
    }
  };
  dfs(from, [], new Set([from]));
  return out;
}

const asSet = (paths) => new Set(paths.map((p) => p.join('>')));

function flipByte(dataPath, indexPath, blockId, payloadOffset = 1) {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const at = index.blocks[blockId].offset + 16 + payloadOffset; // skip header
  const fd = fs.openSync(dataPath, 'r+');
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, at);
  b[0] ^= 0xff;
  fs.writeSync(fd, b, 0, 1, at);
  fs.closeSync(fd);
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => err instanceof QGError && err.code === code);
}

// ---------------------------------------------------------------- tests

test('path/ancestor/descendant sets match independent DFS enumeration', () => {
  const dir = tmpdir();
  const f = files(dir);
  const records = dagRecords();
  encode({ records, ...f, blockSize: 3 });

  const dec = new Decoder(f);
  try {
    for (const lot of records.map((r) => r.lot)) {
      assert.deepEqual(new Set(dec.ancestors(lot)), refAncestors(records, lot), `ancestors ${lot}`);
      assert.deepEqual(new Set(dec.descendants(lot)), refDescendants(records, lot), `descendants ${lot}`);
    }
    // All pairs: full path-set equality with the reference DFS.
    for (const a of records) {
      for (const b of records) {
        assert.deepEqual(
          asSet(dec.paths(a.lot, b.lot)),
          asSet(refPaths(records, a.lot, b.lot)),
          `paths ${a.lot} -> ${b.lot}`
        );
      }
    }
    // Spot-check the multi-path case explicitly.
    assert.deepEqual(asSet(dec.paths('L9', 'L0')), new Set([
      'L9>L7>L6>L5>L3>L0',
      'L9>L7>L6>L5>L4>L2>L0',
    ]));
  } finally {
    dec.close();
  }
});

test('certificates carry block ids, record offsets and boundary hashes', () => {
  const dir = tmpdir();
  const f = files(dir);
  encode({ records: dagRecords(), ...f, blockSize: 2 });
  const dec = new Decoder(f);
  try {
    const { certificates } = dec.pathsWithCertificates('L9', 'L0');
    assert.equal(certificates.length, 2);
    for (const cert of certificates) {
      assert.equal(cert.type, 'qg-path-cert');
      assert.ok(cert.steps.every((s) => Number.isInteger(s.block) && Number.isInteger(s.recordOffset)));
      assert.ok(cert.steps.every((s) => /^[0-9a-f]{64}$/.test(s.recordHash) && /^[0-9a-f]{64}$/.test(s.blockHash)));
      assert.equal(cert.boundary.startHash, cert.steps[0].recordHash);
      assert.equal(cert.boundary.endHash, cert.steps[cert.steps.length - 1].recordHash);
      assert.deepEqual(verifyCertificate(cert, f).ok, true);
    }
  } finally {
    dec.close();
  }
});

test('single corrupted block: unrelated queries work, crossing queries fail with E_CRC', () => {
  const dir = tmpdir();
  const f = files(dir);
  const records = dagRecords();
  encode({ records, ...f, blockSize: 2 }); // 5 blocks: L0L1 L2L3 L4L5 L6L7 L8L9
  flipByte(f.dataPath, f.indexPath, 2); // corrupt block holding L4,L5

  const dec = new Decoder(f);
  try {
    // Unaffected lots remain fully queryable.
    assert.deepEqual(new Set(dec.ancestors('L3')), new Set(['L3', 'L0', 'L1']));
    assert.deepEqual(new Set(dec.descendants('L8')), new Set(['L8', 'L9']));
    assert.deepEqual(asSet(dec.paths('L3', 'L0')), new Set(['L3>L0']));

    // Queries that must cross the corrupted block fail with E_CRC and
    // return no guessed paths.
    expectCode(() => dec.ancestors('L9'), 'E_CRC');
    expectCode(() => dec.descendants('L0'), 'E_CRC');
    expectCode(() => dec.paths('L9', 'L0'), 'E_CRC');
    expectCode(() => dec.pathsWithCertificates('L9', 'L0'), 'E_CRC');

    // A certificate for an unaffected path still verifies standalone.
    const { certificates } = dec.pathsWithCertificates('L3', 'L0');
    assert.equal(certificates.length, 1);
    assert.deepEqual(verifyCertificate(certificates[0], f).ok, true);

    // A certificate touching the corrupted block cannot even be built.
    expectCode(() => dec.certificateForPath(['L5', 'L3', 'L0']), 'E_CRC');
  } finally {
    dec.close();
  }
});

test('append with atomic manifest update: old certs re-verify, new certs cover new blocks', () => {
  const dir = tmpdir();
  const f = files(dir);
  encode({ records: [rec('R0', []), rec('R1', ['R0'])], ...f, blockSize: 8 });

  const dec1 = new Decoder(f);
  const oldCert = dec1.pathsWithCertificates('R1', 'R0').certificates[0];
  dec1.close();
  assert.equal(oldCert.manifestBlocks, 1);
  assert.deepEqual(verifyCertificate(oldCert, f).ok, true);

  const res = appendRecords({ records: [rec('R2', ['R1']), rec('R3', ['R2'])], ...f, blockSize: 8 });
  assert.equal(res.blocksAdded, 1);
  const manifest = JSON.parse(fs.readFileSync(f.manifestPath, 'utf8'));
  assert.equal(manifest.blocks.length, 2);

  // Old certificate still verifies against the extended manifest.
  assert.deepEqual(verifyCertificate(oldCert, f).ok, true);

  const dec2 = new Decoder(f);
  try {
    const { paths, certificates } = dec2.pathsWithCertificates('R3', 'R0');
    assert.deepEqual(paths, [['R3', 'R2', 'R1', 'R0']]);
    const cert = certificates[0];
    assert.equal(cert.manifestBlocks, 2);
    assert.ok(cert.steps.some((s) => s.block === 1), 'new certificate includes the appended block');
    assert.deepEqual(verifyCertificate(cert, f).ok, true);
  } finally {
    dec2.close();
  }
});

test('index/manifest inconsistency yields E_INDEX', () => {
  const dir = tmpdir();
  const f = files(dir);
  encode({ records: dagRecords(), ...f, blockSize: 2 });

  // Case 1: index block offset no longer matches the file layout.
  const idx = JSON.parse(fs.readFileSync(f.indexPath, 'utf8'));
  idx.blocks[1].offset += 8;
  fs.writeFileSync(f.indexPath, JSON.stringify(idx));
  const dec1 = new Decoder(f);
  expectCode(() => dec1.ancestors('L3'), 'E_INDEX');
  dec1.close();

  // Case 2: manifest and index disagree on the block count.
  const dir2 = tmpdir();
  const f2 = files(dir2);
  encode({ records: dagRecords(), ...f2, blockSize: 2 });
  const m = JSON.parse(fs.readFileSync(f2.manifestPath, 'utf8'));
  m.blocks.push('0'.repeat(64));
  fs.writeFileSync(f2.manifestPath, JSON.stringify(m));
  expectCode(() => new Decoder(f2), 'E_INDEX');
});

test('tampered certificate fails standalone verification', () => {
  const dir = tmpdir();
  const f = files(dir);
  encode({ records: dagRecords(), ...f, blockSize: 2 });
  const dec = new Decoder(f);
  let cert;
  try {
    cert = dec.pathsWithCertificates('L9', 'L0').certificates[0];
  } finally {
    dec.close();
  }
  assert.deepEqual(verifyCertificate(cert, f).ok, true);

  const bad1 = JSON.parse(JSON.stringify(cert));
  bad1.steps[0].recordHash = '0'.repeat(64);
  expectCode(() => verifyCertificate(bad1, f), 'E_CERT');

  const bad2 = JSON.parse(JSON.stringify(cert));
  bad2.boundary.endHash = '0'.repeat(64);
  expectCode(() => verifyCertificate(bad2, f), 'E_CERT');

  const bad3 = JSON.parse(JSON.stringify(cert));
  bad3.manifestHash = '0'.repeat(64);
  expectCode(() => verifyCertificate(bad3, f), 'E_MANIFEST');
});

test('CLI end-to-end: encode, paths, verify, corruption exit codes', () => {
  const dir = tmpdir();
  const f = files(dir);
  const recordsPath = path.join(dir, 'records.json');
  fs.writeFileSync(recordsPath, JSON.stringify(dagRecords()));
  const run = (args) => {
    const io = { out: [], err: [] };
    const status = cliRun(args, { out: (s) => io.out.push(s), err: (s) => io.err.push(s) });
    return { status, stdout: io.out.join('\n'), stderr: io.err.join('\n') };
  };

  let r = run(['encode', '--records', recordsPath, '--data', f.dataPath,
    '--manifest', f.manifestPath, '--index', f.indexPath, '--blockSize', '2']);
  assert.equal(r.status, 0, r.stderr);

  const certsPath = path.join(dir, 'certs.json');
  r = run(['paths', '--data', f.dataPath, '--manifest', f.manifestPath,
    '--index', f.indexPath, '--from', 'L9', '--to', 'L0', '--certs', certsPath]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.paths.length, 2);
  assert.equal(out.certificates.length, 2);

  const certs = JSON.parse(fs.readFileSync(certsPath, 'utf8'));
  const certPath = path.join(dir, 'cert0.json');
  fs.writeFileSync(certPath, JSON.stringify(certs[0]));
  r = run(['verify', '--data', f.dataPath, '--manifest', f.manifestPath,
    '--index', f.indexPath, '--cert', certPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).ok, true);

  r = run(['ancestors', '--data', f.dataPath, '--manifest', f.manifestPath,
    '--index', f.indexPath, '--lot', 'L3']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(new Set(JSON.parse(r.stdout).lots), new Set(['L3', 'L0', 'L1']));

  // Corrupt one block: crossing query exits non-zero with E_CRC.
  flipByte(f.dataPath, f.indexPath, 2);
  r = run(['paths', '--data', f.dataPath, '--manifest', f.manifestPath,
    '--index', f.indexPath, '--from', 'L9', '--to', 'L0']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E_CRC/);

  r = run(['ancestors', '--data', f.dataPath, '--manifest', f.manifestPath,
    '--index', f.indexPath, '--lot', 'L3']);
  assert.equal(r.status, 0, r.stderr);
});
