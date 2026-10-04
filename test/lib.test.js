'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SampleCache,
  mergeCertificates,
  crc32,
  blockDigest,
  computeRoot,
} = require('../lib');

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sample-cache-test-'));
}

function writeRandomFile(file, size, rand) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = Math.floor(rand() * 256);
  fs.writeFileSync(file, buf);
  return buf;
}

function bruteForceRoot(sourcePath, chunkSize, generations, start, end, bitmap) {
  const data = fs.readFileSync(sourcePath);
  const digests = [];
  for (let idx = start; idx <= end; idx += 1) {
    if (bitmap[idx - start] !== '1') continue;
    const off = idx * chunkSize;
    const chunk = data.subarray(off, Math.min(off + chunkSize, data.length));
    digests.push(blockDigest(generations[idx], crc32(chunk), chunk));
  }
  return computeRoot(digests);
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `expected ${code}`);
}

test('random corrections match brute-force recomputed roots', () => {
  const rand = lcg(12345);
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  const chunkSize = 64;
  const blockCount = 12;
  writeRandomFile(source, chunkSize * blockCount, rand);

  const cache = new SampleCache({ capacity: 1 << 20 });
  cache.ingest('s1', source, { chunkSize });
  const generations = new Array(blockCount).fill(1);

  for (let round = 0; round < 40; round += 1) {
    const s = Math.floor(rand() * blockCount);
    const e = s + Math.floor(rand() * (blockCount - s));
    const data = fs.readFileSync(source);
    for (let idx = s; idx <= e; idx += 1) {
      const off = idx * chunkSize;
      for (let b = 0; b < chunkSize; b += 1) data[off + b] = Math.floor(rand() * 256);
    }
    fs.writeFileSync(source, data);
    cache.correctRange('s1', s, e);
    for (let idx = s; idx <= e; idx += 1) generations[idx] += 1;

    if (round % 3 === 0) {
      const ws = Math.floor(rand() * blockCount);
      const we = ws + Math.floor(rand() * (blockCount - ws));
      const cert = cache.certify('s1', ws, we);
      const windowGens = generations.slice(ws, we + 1);
      const maxGen = Math.max(...windowGens);
      assert.equal(cert.generation, maxGen);
      const expectedBitmap = windowGens.map((g) => (g === maxGen ? '1' : '0')).join('');
      assert.equal(cert.bitmap, expectedBitmap);
      const brute = bruteForceRoot(source, chunkSize, generations, ws, we, cert.bitmap);
      assert.equal(cert.root, brute, `round ${round} window [${ws}, ${we}]`);
      assert.deepEqual(cache.checkCert('s1', cert).ok, true);
    }
  }
});

test('stale certificates are rejected with ERR_STALE', () => {
  const rand = lcg(777);
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  const chunkSize = 32;
  writeRandomFile(source, chunkSize * 8, rand);
  const cache = new SampleCache({ capacity: 1 << 20 });
  cache.ingest('s1', source, { chunkSize });

  const cert = cache.certify('s1', 2, 5);
  assert.equal(cache.checkCert('s1', cert).ok, true);

  const data = fs.readFileSync(source);
  data[3 * chunkSize] ^= 0xff;
  fs.writeFileSync(source, data);
  cache.correctRange('s1', 3, 3);

  expectCode(() => cache.checkCert('s1', cert), 'ERR_STALE');

  const fresh = cache.certify('s1', 2, 5);
  assert.equal(cache.checkCert('s1', fresh).ok, true);

  const before = cache.certify('s1', 0, 1);
  const other = fs.readFileSync(source);
  other[6 * chunkSize] ^= 0x01;
  fs.writeFileSync(source, other);
  cache.correctRange('s1', 6, 6);
  assert.equal(cache.checkCert('s1', before).ok, true);
});

test('merge rules: adjacent+same generation merge, overlap or different generation stay parallel', () => {
  const rand = lcg(4242);
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  const chunkSize = 16;
  writeRandomFile(source, chunkSize * 8, rand);
  const cache = new SampleCache({ capacity: 1 << 20 });
  cache.ingest('s1', source, { chunkSize });

  const c1 = cache.certify('s1', 0, 2);
  const c2 = cache.certify('s1', 3, 5);
  const merged = mergeCertificates([c2, c1]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].window, { start: 0, end: 5 });
  assert.equal(merged[0].bitmap, '111111');
  assert.equal(cache.checkCert('s1', merged[0]).ok, true);
  assert.equal(merged[0].root, cache.certify('s1', 0, 5).root);

  const coverlap = cache.certify('s1', 2, 4);
  const parallel = mergeCertificates([c1, coverlap]);
  assert.equal(parallel.length, 2);

  const data = fs.readFileSync(source);
  data[3 * chunkSize] ^= 0xaa;
  fs.writeFileSync(source, data);
  cache.correctRange('s1', 3, 3);
  const c3 = cache.certify('s1', 3, 5);
  assert.equal(c3.generation, 2);
  assert.equal(c3.bitmap, '100');
  const mixed = mergeCertificates([cache.certify('s1', 0, 2), c3]);
  assert.equal(mixed.length, 2);
  assert.equal(cache.checkCert('s1', mixed[0]).ok, true);
  assert.equal(cache.checkCert('s1', mixed[1]).ok, true);

  const gap = mergeCertificates([cache.certify('s1', 0, 1), cache.certify('s1', 4, 5)]);
  assert.equal(gap.length, 2);
});

test('LRU evicts by bytes at exact capacity boundary without breaking correctness', () => {
  const rand = lcg(99);
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  const chunkSize = 100;
  const blockCount = 5;
  writeRandomFile(source, chunkSize * blockCount, rand);

  const exact = new SampleCache({ capacity: 400 });
  exact.ingest('s1', source, { chunkSize });
  exact.certify('s1', 0, 3);
  assert.deepEqual(exact.stats(), { capacity: 400, usedBytes: 400, cachedBlocks: 4 });

  const tight = new SampleCache({ capacity: 399 });
  tight.ingest('s1', source, { chunkSize });
  tight.certify('s1', 0, 3);
  assert.equal(tight.stats().cachedBlocks, 3);
  assert.equal(tight.stats().usedBytes, 300);

  const cert = tight.certify('s1', 0, 4);
  assert.equal(tight.stats().cachedBlocks, 3);
  const generations = new Array(blockCount).fill(1);
  const brute = bruteForceRoot(source, chunkSize, generations, 0, 4, cert.bitmap);
  assert.equal(cert.root, brute);
  assert.equal(tight.checkCert('s1', cert).ok, true);

  const data = fs.readFileSync(source);
  data[0] ^= 0xff;
  fs.writeFileSync(source, data);
  tight.correctRange('s1', 0, 0);
  expectCode(() => tight.checkCert('s1', cert), 'ERR_STALE');
});

test('corrupted cache block is repaired from source; doubly corrupt reports ERR_SOURCE', () => {
  const rand = lcg(31337);
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  const chunkSize = 32;
  writeRandomFile(source, chunkSize * 4, rand);
  const cache = new SampleCache({ capacity: 1 << 20 });
  cache.ingest('s1', source, { chunkSize });
  const cert = cache.certify('s1', 0, 3);

  cache.cache.get('s1:1').data[0] ^= 0xff;
  assert.equal(cache.checkCert('s1', cert).ok, true);

  cache.cache.get('s1:1').data[0] ^= 0xff;
  const bad = fs.readFileSync(source);
  bad[chunkSize] ^= 0xff;
  fs.writeFileSync(source, bad);
  expectCode(() => cache.checkCert('s1', cert), 'ERR_SOURCE');

  const good = fs.readFileSync(source);
  good[chunkSize] ^= 0xff;
  fs.writeFileSync(source, good);
  assert.equal(cache.checkCert('s1', cert).ok, true);

  cache.invalidate('s1', 2, 2);
  const bad2 = fs.readFileSync(source);
  bad2[2 * chunkSize + 5] ^= 0xff;
  fs.writeFileSync(source, bad2);
  expectCode(() => cache.checkCert('s1', cert), 'ERR_SOURCE');
});

test('invalid ranges report ERR_RANGE', () => {
  const rand = lcg(5);
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  writeRandomFile(source, 100, rand);
  const cache = new SampleCache({ capacity: 1 << 20 });
  cache.ingest('s1', source, { chunkSize: 32 });

  expectCode(() => cache.certify('s1', -1, 2), 'ERR_RANGE');
  expectCode(() => cache.certify('s1', 2, 1), 'ERR_RANGE');
  expectCode(() => cache.certify('s1', 0, 4), 'ERR_RANGE');
  expectCode(() => cache.correctRange('s1', 3, 9), 'ERR_RANGE');
  expectCode(() => cache.certify('nope', 0, 1), 'ERR_RANGE');

  const cert = cache.certify('s1', 0, 1);
  expectCode(() => cache.checkCert('other', cert), 'ERR_RANGE');
  expectCode(() => cache.checkCert('s1', { ...cert, window: { start: 0, end: 99 } }), 'ERR_RANGE');
  expectCode(() => cache.checkCert('s1', { junk: true }), 'ERR_CRC');
  const flipped = (cert.root[0] === '0' ? '1' : '0') + cert.root.slice(1);
  expectCode(() => cache.checkCert('s1', { ...cert, root: flipped }), 'ERR_CRC');
});
