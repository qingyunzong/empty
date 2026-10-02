'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ev = require('../evidence.js');
const { run } = require('../cli.js');
const BLOCK = 64;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
}

function runCliOk(args) {
  const r = run(args);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  return JSON.parse(r.stdout.toString('utf8'));
}

function runCliErr(args) {
  const r = run(args);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}`);
  return JSON.parse(r.stderr.toString('utf8'));
}

function packDir(dir, data, blockSize = BLOCK) {
  const raw = path.join(dir, 'raw.bin');
  const dataPath = path.join(dir, 'data.bin');
  const idxPath = path.join(dir, 'idx.json');
  fs.writeFileSync(raw, data);
  const out = runCliOk(['pack', raw, dataPath, idxPath, String(blockSize)]);
  return { dataPath, idxPath, pack: out };
}

test('acceptance 1: random packages match brute-force per-block recomputation', () => {
  const sizes = [0, 1, 7, BLOCK - 1, BLOCK, BLOCK + 1, 3 * BLOCK + 5, 1000];
  for (const size of sizes) {
    const data = crypto.randomBytes(size);
    const index = ev.buildIndex(data, BLOCK);

    const blocks = [];
    for (let off = 0, i = 0; off < data.length; off += BLOCK, i++) {
      const slice = data.subarray(off, Math.min(off + BLOCK, data.length));
      blocks.push({ index: i, offset: off, length: slice.length,
                    sha256: crypto.createHash('sha256').update(slice).digest('hex') });
    }
    assert.deepEqual(
      index.blocks.map((b) => [b.index, b.offset, b.length, b.sha256]),
      blocks.map((b) => [b.index, b.offset, b.length, b.sha256]),
      `block table mismatch at size ${size}`);

    const leaves = blocks.map((b) => ev.leafHash(b.index, b.length, Buffer.from(b.sha256, 'hex')));
    const bruteRoot = ev.merkleRootFromLeafHashes(leaves).toString('hex');
    assert.equal(index.root, bruteRoot, `root mismatch at size ${size}`);
    assert.equal(index.totalSize, size);

    ev.validateIndex(index);
    const dir = tmpdir();
    const { dataPath, idxPath } = packDir(dir, data);
    const v = runCliOk(['verify', dataPath, idxPath]);
    assert.equal(v.root, index.root);
  }
});

test('acceptance 2: one-byte flip fails proof and names the leaf', () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(5 * BLOCK);
  const { dataPath, idxPath } = packDir(dir, data);

  const proofPath = path.join(dir, 'proof.json');
  runCliOk(['prove', dataPath, idxPath, '8', '9', proofPath]);
  const checked = runCliOk(['checkProof', proofPath]);
  assert.equal(checked.root, JSON.parse(fs.readFileSync(idxPath, 'utf8')).root);

  const corrupted = Buffer.from(fs.readFileSync(dataPath));
  const pos = 2 * BLOCK + 3;
  corrupted[pos] ^= 0x01;
  fs.writeFileSync(dataPath, corrupted);
  const expectedLeaf = Math.floor(pos / BLOCK);

  const v = runCliErr(['verify', dataPath, idxPath]);
  assert.equal(v.code, 'ERR_INDEX');
  assert.deepEqual(v.leaves, [expectedLeaf]);

  const p = runCliErr(['prove', dataPath, idxPath, '8', '9']);
  assert.equal(p.code, 'ERR_ROOT');
  assert.deepEqual(p.leaves, [expectedLeaf]);

  const e = runCliErr(['extract', dataPath, idxPath, String(pos), '1', path.join(dir, 'x.bin')]);
  assert.equal(e.code, 'ERR_ROOT');
  assert.deepEqual(e.leaves, [expectedLeaf]);
});

test('acceptance 3: deleted index, degraded scan rebuilds identical root', () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(3 * BLOCK + 11);
  const { dataPath, idxPath, pack } = packDir(dir, data);
  fs.unlinkSync(idxPath);

  const v = runCliOk(['verify', dataPath, idxPath, String(BLOCK)]);
  assert.equal(v.degraded, 'scan');
  assert.equal(v.root, pack.root);

  const s = runCliOk(['scan', dataPath, String(BLOCK)]);
  assert.equal(s.root, pack.root);
});

test('acceptance 4a: empty package', () => {
  const dir = tmpdir();
  const { dataPath, idxPath, pack } = packDir(dir, Buffer.alloc(0));
  assert.equal(pack.blocks, 0);
  assert.equal(pack.root, ev.emptyRoot().toString('hex'));

  const v = runCliOk(['verify', dataPath, idxPath]);
  assert.equal(v.root, pack.root);

  const out = path.join(dir, 'empty.out');
  runCliOk(['extract', dataPath, idxPath, '0', '0', out]);
  assert.equal(fs.readFileSync(out).length, 0);

  const p = runCliErr(['prove', dataPath, idxPath, '0', '1']);
  assert.equal(p.code, 'ERR_RANGE');
});

test('acceptance 4b: single block package', () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(17);
  const { dataPath, idxPath, pack } = packDir(dir, data);
  assert.equal(pack.blocks, 1);

  runCliOk(['verify', dataPath, idxPath]);
  const proofPath = path.join(dir, 'p.json');
  runCliOk(['prove', dataPath, idxPath, '0', '17', proofPath]);
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  assert.equal(proof.siblings.length, 0);
  runCliOk(['checkProof', proofPath]);

  const out = path.join(dir, 'single.out');
  runCliOk(['extract', dataPath, idxPath, '3', '10', out]);
  assert.deepEqual(fs.readFileSync(out), data.subarray(3, 13));
});

test('acceptance 4c: extract spanning three blocks', () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(4 * BLOCK);
  const { dataPath, idxPath } = packDir(dir, data);
  const offset = BLOCK - 5;
  const length = 2 * BLOCK + 10;
  const out = path.join(dir, 'span.out');
  const r = runCliOk(['extract', dataPath, idxPath, String(offset), String(length), out]);
  assert.deepEqual(fs.readFileSync(out), data.subarray(offset, offset + length));
  assert.equal(r.sha256, crypto.createHash('sha256')
    .update(data.subarray(offset, offset + length)).digest('hex'));
});

test('cross-leaf proof merges adjacent paths and dedupes siblings', () => {
  const data = crypto.randomBytes(8 * BLOCK);
  const index = ev.buildIndex(data, BLOCK);
  const offset = BLOCK + 1;
  const length = 3 * BLOCK - 2;
  const proof = ev.makeProof(index, offset, length);
  assert.equal(proof.startLeaf, 1);
  assert.equal(proof.leaves.length, 3);

  const keys = proof.siblings.map((s) => `${s.level}:${s.index}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate sibling entries');

  const leaves = ev.leafHashesOf(index.blocks);
  const perLeaf = [];
  for (let i = proof.startLeaf; i < proof.startLeaf + 3; i++) {
    perLeaf.push(...ev.buildProof(leaves, i, i).map((s) => `${s.level}:${s.index}`));
  }
  assert.ok(keys.length < perLeaf.length, 'merged proof must be smaller than naive concat');

  assert.deepEqual(ev.checkProof(proof), { root: index.root });
  assert.deepEqual(ev.checkProof(proof, index.root), { root: index.root });
});

test('checkProof rejects tampered leaf and wrong root with ERR_PROOF', () => {
  const data = crypto.randomBytes(4 * BLOCK);
  const index = ev.buildIndex(data, BLOCK);
  const proof = ev.makeProof(index, 10, 100);

  const tampered = JSON.parse(JSON.stringify(proof));
  tampered.leaves[0].sha256 = crypto.randomBytes(32).toString('hex');
  assert.throws(() => ev.checkProof(tampered), (e) => e.code === 'ERR_PROOF');

  const wrongRoot = crypto.randomBytes(32).toString('hex');
  assert.throws(() => ev.checkProof(proof, wrongRoot), (e) => e.code === 'ERR_PROOF');

  const dir = tmpdir();
  const proofPath = path.join(dir, 'p.json');
  fs.writeFileSync(proofPath, JSON.stringify(tampered));
  const r = runCliErr(['checkProof', proofPath]);
  assert.equal(r.code, 'ERR_PROOF');
});

test('size change makes corruption unlocalizable: ERR_AMBIGUOUS', () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(3 * BLOCK);
  const { dataPath, idxPath } = packDir(dir, data);
  fs.writeFileSync(dataPath, Buffer.concat([fs.readFileSync(dataPath), Buffer.from([0])]));
  const r = runCliErr(['verify', dataPath, idxPath]);
  assert.equal(r.code, 'ERR_AMBIGUOUS');
});

test('out-of-range requests yield ERR_RANGE', () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(2 * BLOCK);
  const { dataPath, idxPath } = packDir(dir, data);
  assert.equal(runCliErr(['prove', dataPath, idxPath, '0', String(2 * BLOCK + 1)]).code, 'ERR_RANGE');
  assert.equal(runCliErr(['prove', dataPath, idxPath, '-1', '5']).code, 'ERR_RANGE');
  assert.equal(runCliErr(['extract', dataPath, idxPath, '100', '50', path.join(dir, 'o')]).code, 'ERR_RANGE');
});

test('malformed index yields ERR_FORMAT', () => {
  const dir = tmpdir();
  const data = crypto.randomBytes(10);
  const { dataPath, idxPath } = packDir(dir, data);
  fs.writeFileSync(idxPath, '{not json');
  assert.equal(runCliErr(['verify', dataPath, idxPath]).code, 'ERR_FORMAT');

  const index = ev.buildIndex(data, BLOCK);
  index.blocks[0].sha256 = 'zz' + index.blocks[0].sha256.slice(2);
  fs.writeFileSync(idxPath, JSON.stringify(index));
  assert.equal(runCliErr(['verify', dataPath, idxPath]).code, 'ERR_FORMAT');
});
