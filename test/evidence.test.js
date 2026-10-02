'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ev = require('../lib/evidence');
const { run } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
}

// Invokes the CLI in-process (the offline sandbox forbids child processes)
// and captures { code, stdout, stderr }.
function cli(argv) {
  const out = [];
  const err = [];
  const code = run(argv, {
    stdout: (chunk) => out.push(Buffer.from(chunk)),
    stderr: (chunk) => err.push(Buffer.from(chunk)),
  });
  return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

function cliJson(argv) {
  const res = cli(argv);
  assert.equal(res.code, 0, res.stderr.toString());
  return JSON.parse(res.stdout.toString());
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Independent brute-force reference: hash every block, fold the Merkle
// tree level by level, promote odd nodes.
function bruteForceRoot(data, blockSize) {
  const leaves = [];
  for (let off = 0; off < data.length; off += blockSize) {
    leaves.push(Buffer.from(sha256hex(data.subarray(off, Math.min(off + blockSize, data.length))), 'hex'));
  }
  if (leaves.length === 0) return sha256hex(Buffer.alloc(0));
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length
        ? Buffer.from(sha256hex(Buffer.concat([level[i], level[i + 1]])), 'hex')
        : level[i]);
    }
    level = next;
  }
  return level[0].toString('hex');
}

test('acceptance 1: random packages match brute-force per-block recomputation', () => {
  const sizes = [0, 1, 15, 16, 17, 100, 255, 256, 257, 1000, 4095, 4096, 4097, 9000];
  for (let round = 0; round < 40; round++) sizes.push(crypto.randomInt(0, 12000));
  for (const size of sizes) {
    const blockSize = [8, 16, 64, 4096][size % 4];
    const data = crypto.randomBytes(size);
    const index = ev.buildIndex(data, blockSize);
    // per-block hashes must match an independent recomputation
    for (const b of index.blocks) {
      assert.equal(b.sha256, sha256hex(data.subarray(b.offset, b.offset + b.length)), `block ${b.index} size ${size}`);
      assert.equal(b.length, Math.min(blockSize, size - b.index * blockSize));
    }
    assert.equal(index.root, bruteForceRoot(data, blockSize), `root size ${size} bs ${blockSize}`);
    assert.deepEqual(ev.verify(data, index), { ok: true, root: index.root, blockCount: index.blockCount });
  }
});

test('acceptance 2: one-byte corruption fails proof and names the leaf', () => {
  const blockSize = 16;
  const data = crypto.randomBytes(3 * blockSize); // 3 blocks
  const index = ev.buildIndex(data, blockSize);

  // honest proof for a range inside block 1 verifies against the root alone
  const proof = ev.generateProof(index, 20, 5);
  assert.deepEqual(ev.checkProof(proof, index.root), { ok: true, root: index.root });

  // flip one byte inside block 1
  const corrupted = Buffer.from(data);
  corrupted[20] ^= 0x01;

  // verify reports ERR_ROOT with the minimal leaf set {1}
  assert.throws(() => ev.verify(corrupted, index), (err) => {
    assert.equal(err.code, 'ERR_ROOT');
    assert.deepEqual(err.leaves, [1]);
    return true;
  });

  // extract over the corrupted block refuses and names the leaf
  assert.throws(() => ev.extract(corrupted, index, 20, 5), (err) => {
    assert.equal(err.code, 'ERR_ROOT');
    assert.deepEqual(err.leaves, [1]);
    return true;
  });

  // a proof rebuilt from corrupted leaf data no longer matches the root
  const badIndex = ev.buildIndex(corrupted, blockSize);
  const badProof = ev.generateProof(badIndex, 20, 5);
  assert.throws(() => ev.checkProof(badProof, index.root), (err) => {
    assert.equal(err.code, 'ERR_PROOF');
    assert.equal(err.expected, index.root);
    return true;
  });

  // CLI: prove on corrupted data exits 1 and points at leaf 1 on stderr
  const dir = tmpdir();
  const dataPath = path.join(dir, 'data.bin');
  const idxPath = path.join(dir, 'idx.json');
  fs.writeFileSync(dataPath, corrupted);
  fs.writeFileSync(idxPath, JSON.stringify(index));
  const res = cli(['prove', dataPath, idxPath, '20', '5']);
  assert.equal(res.code, 1);
  const payload = JSON.parse(res.stderr.toString());
  assert.equal(payload.error, 'ERR_ROOT');
  assert.deepEqual(payload.leaves, [1]);
});

test('acceptance 3: scan rebuilds identical root after index loss', () => {
  const dir = tmpdir();
  const dataPath = path.join(dir, 'data.bin');
  const idxPath = path.join(dir, 'idx.json');
  fs.writeFileSync(dataPath, crypto.randomBytes(5000));
  const packed = cliJson(['pack', dataPath, idxPath]);
  fs.unlinkSync(idxPath); // index lost
  const scanned = cliJson(['scan', dataPath]);
  assert.equal(scanned.root, packed.root);
});

test('acceptance 4a: empty package packs, verifies, rejects prove/extract', () => {
  const data = Buffer.alloc(0);
  const index = ev.buildIndex(data);
  assert.equal(index.blockCount, 0);
  assert.equal(index.root, sha256hex(Buffer.alloc(0)));
  assert.deepEqual(ev.verify(data, index), { ok: true, root: index.root, blockCount: 0 });
  assert.throws(() => ev.generateProof(index, 0, 1), (err) => err.code === 'ERR_RANGE');
  assert.throws(() => ev.extract(data, index, 0, 1), (err) => err.code === 'ERR_RANGE');
});

test('acceptance 4b: single block (tail-only) package round-trips', () => {
  const data = crypto.randomBytes(10);
  const index = ev.buildIndex(data, 4096);
  assert.equal(index.blockCount, 1);
  assert.equal(index.blocks[0].length, 10);
  const proof = ev.generateProof(index, 0, 10);
  assert.equal(proof.path.length, 0); // single leaf needs no siblings
  assert.deepEqual(ev.checkProof(proof, index.root), { ok: true, root: index.root });
  assert.deepEqual(ev.extract(data, index, 3, 4), data.subarray(3, 7));
});

test('acceptance 4c: extract spanning three blocks returns exact bytes', () => {
  const blockSize = 16;
  const data = crypto.randomBytes(100); // 7 blocks
  const index = ev.buildIndex(data, blockSize);
  const out = ev.extract(data, index, 8, 40); // covers blocks 0, 1, 2
  assert.deepEqual(out, data.subarray(8, 48));
  // proof for the same range spans leaves 0..2 and verifies from root alone
  const proof = ev.generateProof(index, 8, 40);
  assert.equal(proof.firstLeaf, 0);
  assert.equal(proof.lastLeaf, 2);
  assert.deepEqual(ev.checkProof(proof, index.root), { ok: true, root: index.root });
});

test('cross-leaf proof merges adjacent paths and dedupes nodes', () => {
  const blockSize = 8;
  const data = crypto.randomBytes(8 * blockSize); // 8 leaves, 3 tree levels
  const index = ev.buildIndex(data, blockSize);
  const proof = ev.generateProof(index, 8, 40); // leaves 1..5
  const keys = proof.path.map((n) => `${n.level}:${n.index}`);
  assert.equal(new Set(keys).size, keys.length, 'path must be deduped');
  // minimal sibling set for span [1,5] over 8 leaves: leaf 0 and node (1,3)
  assert.deepEqual(keys.sort(), ['0:0', '1:3']);
  assert.deepEqual(ev.checkProof(proof, index.root), { ok: true, root: index.root });
  // full-range proof needs no path nodes at all
  const full = ev.generateProof(index, 0, data.length);
  assert.equal(full.path.length, 0);
  assert.deepEqual(ev.checkProof(full, index.root), { ok: true, root: index.root });
});

test('index/data root mismatch yields ERR_INDEX with degraded scan root', () => {
  const data = crypto.randomBytes(100);
  const index = ev.buildIndex(data, 16);
  const tampered = JSON.parse(JSON.stringify(index));
  tampered.root = sha256hex(Buffer.from('forged'));
  assert.throws(() => ev.verify(data, tampered), (err) => {
    assert.equal(err.code, 'ERR_INDEX');
    assert.equal(err.scannedRoot, index.root); // degraded scan still recovers the real root
    return true;
  });
});

test('length-changing corruption cannot be uniquely located: ERR_AMBIGUOUS', () => {
  const data = crypto.randomBytes(100);
  const index = ev.buildIndex(data, 16);
  const truncated = data.subarray(0, 99);
  assert.throws(() => ev.verify(truncated, index), (err) => {
    assert.equal(err.code, 'ERR_AMBIGUOUS');
    return true;
  });
});

test('malformed index and out-of-range requests raise ERR_FORMAT / ERR_RANGE', () => {
  const data = crypto.randomBytes(32);
  const index = ev.buildIndex(data, 16);
  assert.throws(() => ev.verify(data, { hello: 'world' }), (err) => err.code === 'ERR_FORMAT');
  const broken = JSON.parse(JSON.stringify(index));
  broken.blocks[0].sha256 = 'zzzz';
  assert.throws(() => ev.verify(data, broken), (err) => err.code === 'ERR_FORMAT');
  assert.throws(() => ev.generateProof(index, 31, 2), (err) => err.code === 'ERR_RANGE');
  assert.throws(() => ev.generateProof(index, -1, 2), (err) => err.code === 'ERR_RANGE');
});

test('CLI end-to-end: pack, prove 8 9, checkProof, extract, verify', () => {
  const dir = tmpdir();
  const dataPath = path.join(dir, 'data.bin');
  const idxPath = path.join(dir, 'idx.json');
  const proofPath = path.join(dir, 'proof.json');
  const data = crypto.randomBytes(100);
  fs.writeFileSync(dataPath, data);

  const packed = cliJson(['pack', dataPath, idxPath]);
  assert.equal(packed.ok, true);

  const proved = cli(['prove', dataPath, idxPath, '8', '9']);
  assert.equal(proved.code, 0, proved.stderr.toString());
  fs.writeFileSync(proofPath, proved.stdout);
  const proof = JSON.parse(proved.stdout.toString());
  assert.equal(proof.range.offset, 8);
  assert.equal(proof.range.length, 9);

  const checked = cliJson(['checkProof', proofPath, packed.root]);
  assert.deepEqual(checked, { ok: true, root: packed.root });

  const extracted = cli(['extract', dataPath, idxPath, '8', '9']);
  assert.equal(extracted.code, 0);
  assert.deepEqual(extracted.stdout, data.subarray(8, 17));

  const verified = cliJson(['verify', dataPath, idxPath]);
  assert.deepEqual(verified, { ok: true, root: packed.root, blockCount: 1 });

  // corrupt one bit: verify exits 1 with ERR_ROOT JSON on stderr naming leaf 0
  const corrupted = Buffer.from(data);
  corrupted[50] ^= 0x80; // single-bit flip
  fs.writeFileSync(dataPath, corrupted);
  const res = cli(['verify', dataPath, idxPath]);
  assert.equal(res.code, 1);
  const payload = JSON.parse(res.stderr.toString());
  assert.equal(payload.error, 'ERR_ROOT');
  assert.deepEqual(payload.leaves, [0]);
});
