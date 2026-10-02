'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SampleCache, CacheError } = require('../lib/cache');
const { crc32 } = require('../lib/crc32');
const { leafHash, merkleRoot } = require('../lib/merkle');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'samplecache-')); }

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSample(dir, size, seed, name = 'sample.bin') {
  const rnd = mulberry32(seed);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rnd() * 256);
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function cachedIndexes(cache) {
  return cache.meta.blocks.map((b, i) => (b.cached ? i : -1)).filter(i => i >= 0);
}

test('acceptance 1: random corrections match brute-force recomputed root', () => {
  const dir = tmpdir();
  const blockSize = 256;
  const blocks = 16;
  const size = blockSize * blocks;
  const sample = randomSample(dir, size, 42);
  const cache = SampleCache.ingest(sample, { blockSize, capacity: 1 << 20 });
  const shadowGens = new Array(blocks).fill(0);
  const rnd = mulberry32(1337);
  for (let iter = 0; iter < 50; iter++) {
    const start = Math.floor(rnd() * (size - 1));
    const end = start + 1 + Math.floor(rnd() * (size - start - 1));
    const payload = Buffer.alloc(end - start);
    for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(rnd() * 256);
    cache.correctRange(start, end, payload);
    for (let b = Math.floor(start / blockSize); b < Math.ceil(end / blockSize); b++) shadowGens[b]++;
  }
  const cert = cache.certify(0, size);
  // brute force: recompute the root straight from source bytes + shadow generations
  const src = fs.readFileSync(sample);
  const leaves = [];
  for (let i = 0; i < blocks; i++) {
    const chunk = src.subarray(i * blockSize, (i + 1) * blockSize);
    leaves.push(leafHash(i, shadowGens[i], crc32(chunk), chunk));
  }
  const expected = merkleRoot(leaves).toString('hex');
  assert.equal(cert.root, expected);
  assert.deepEqual(cert.generations, shadowGens);
  assert.equal(cache.meta.root, expected);
  assert.equal(cache.checkCert(cert).ok, true);
});

test('acceptance 2: stale certificates are rejected with ERR_STALE', () => {
  const dir = tmpdir();
  const blockSize = 128;
  const size = 1024;
  const sample = randomSample(dir, size, 7);
  const cache = SampleCache.ingest(sample, { blockSize });
  const cert = cache.certify(0, 512); // blocks 0..3
  assert.equal(cache.checkCert(cert).ok, true);
  // correction outside the certified window keeps the cert valid
  cache.correctRange(768, 896, Buffer.alloc(128, 9));
  assert.equal(cache.checkCert(cert).ok, true);
  // correction inside the window stales the cert
  cache.correctRange(10, 20, Buffer.alloc(10, 1));
  assert.throws(() => cache.checkCert(cert),
    e => e instanceof CacheError && e.code === 'ERR_STALE');
  // CLI reports ERR_STALE as JSON on stderr
  const certFile = path.join(dir, 'cert.json');
  fs.writeFileSync(certFile, JSON.stringify(cert));
  const r = runCli(['checkCert', sample, certFile]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr.trim()).error, 'ERR_STALE');
});

test('acceptance 3: merge rules for adjacent / overlapping / divergent certs', () => {
  const blockSize = 128;
  const size = 1024; // 8 blocks

  // adjacent windows + identical generations -> merge
  {
    const dir = tmpdir();
    const sample = randomSample(dir, size, 99);
    const cache = SampleCache.ingest(sample, { blockSize });
    const c1 = cache.certify(0, 2 * blockSize);
    const c2 = cache.certify(2 * blockSize, 4 * blockSize);
    assert.equal(SampleCache.canMerge(c1, c2), true);
    const merged = cache.mergeCerts(c1, c2);
    assert.deepEqual(merged.window, [0, 4]);
    // the cert store collapsed adjacent certs into one
    assert.deepEqual(cache.listCerts().map(c => c.window), [[0, 4]]);
    const fresh = cache.certify(0, 4 * blockSize);
    assert.equal(merged.root, fresh.root);
    assert.equal(cache.checkCert(merged).ok, true);
  }

  // overlapping windows -> never merge, kept side by side
  {
    const dir = tmpdir();
    const sample = randomSample(dir, size, 100);
    const cache = SampleCache.ingest(sample, { blockSize });
    const c1 = cache.certify(0, 3 * blockSize);
    const c2 = cache.certify(2 * blockSize, 4 * blockSize);
    assert.equal(SampleCache.canMerge(c1, c2), false);
    assert.equal(cache.mergeCerts(c1, c2), null);
    assert.deepEqual(cache.listCerts().map(c => c.window), [[0, 3], [2, 4]]);
  }

  // adjacent windows but different generations -> no merge
  {
    const dir = tmpdir();
    const sample = randomSample(dir, size, 101);
    const cache = SampleCache.ingest(sample, { blockSize });
    cache.correctRange(2 * blockSize, 4 * blockSize, Buffer.alloc(2 * blockSize, 3));
    const c1 = cache.certify(0, 2 * blockSize);       // generations [0, 0]
    const c2 = cache.certify(2 * blockSize, 4 * blockSize); // generations [1, 1]
    assert.equal(SampleCache.canMerge(c1, c2), false);
    assert.equal(cache.mergeCerts(c1, c2), null);
    assert.deepEqual(cache.listCerts().map(c => c.window), [[0, 2], [2, 4]]);
  }

  // gap between windows -> no merge
  {
    const dir = tmpdir();
    const sample = randomSample(dir, size, 102);
    const cache = SampleCache.ingest(sample, { blockSize });
    const c1 = cache.certify(0, 2 * blockSize);
    const c2 = cache.certify(4 * blockSize, 6 * blockSize);
    assert.equal(SampleCache.canMerge(c1, c2), false);
    assert.equal(cache.mergeCerts(c1, c2), null);
    assert.deepEqual(cache.listCerts().map(c => c.window), [[0, 2], [4, 6]]);
  }
});

test('acceptance 4: LRU eviction at exact byte capacity', () => {
  const dir = tmpdir();
  const blockSize = 256;
  const size = blockSize * 5;
  const sample = randomSample(dir, size, 5);
  const capacity = 4 * blockSize; // exactly four blocks
  const cache = SampleCache.ingest(sample, { blockSize, capacity });
  // ingest inserts blocks 0..4; exactly the oldest block (0) is evicted
  assert.deepEqual(cachedIndexes(cache), [1, 2, 3, 4]);
  assert.equal(cache.stats().cachedBytes, capacity); // exactly at capacity, no more evictions
  // touching block 0 re-reads it from source and evicts exactly the LRU block (1)
  cache.certify(0, blockSize);
  assert.deepEqual(cachedIndexes(cache), [0, 2, 3, 4]);
  assert.equal(cache.stats().cachedBytes, capacity);
  // eviction never affects correctness
  const cert = cache.certify(0, size);
  assert.equal(cache.checkCert(cert).ok, true);
  assert.ok(cache.stats().cachedBytes <= capacity);
});

test('acceptance 5: corrupt cache repaired, corrupt cache+source -> ERR_SOURCE', () => {
  const dir = tmpdir();
  const blockSize = 128;
  const size = 512;
  const sample = randomSample(dir, size, 11);
  const cacheDir = path.join(dir, 'cache');
  const cache = SampleCache.ingest(sample, { blockSize, cacheDir });
  const cert = cache.certify(0, size);
  const blockFile = path.join(cacheDir, 'blocks', '000001.bin');
  const junk = Buffer.alloc(blockSize, 0xaa);

  // corrupt only the cached copy -> transparently repaired from source
  fs.writeFileSync(blockFile, junk);
  const ok = cache.checkCert(cert);
  assert.equal(ok.ok, true);
  assert.ok(ok.repaired >= 1);
  assert.equal(crc32(fs.readFileSync(blockFile)), cache.meta.blocks[1].crc);

  // corrupt both cache and source -> ERR_SOURCE
  fs.writeFileSync(blockFile, junk);
  const fd = fs.openSync(sample, 'r+');
  fs.writeSync(fd, junk, 0, blockSize, blockSize);
  fs.closeSync(fd);
  assert.throws(() => cache.checkCert(cert),
    e => e instanceof CacheError && e.code === 'ERR_SOURCE');
  const certFile = path.join(dir, 'cert.json');
  fs.writeFileSync(certFile, JSON.stringify(cert));
  const r = runCli(['checkCert', sample, certFile, '--cache-dir', cacheDir]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr.trim()).error, 'ERR_SOURCE');
});

test('error mapping: ERR_RANGE and ERR_CRC', () => {
  const dir = tmpdir();
  const blockSize = 128;
  const size = 512;
  const sample = randomSample(dir, size, 21);
  const cache = SampleCache.ingest(sample, { blockSize });
  assert.throws(() => cache.certify(0, 9999), e => e.code === 'ERR_RANGE');
  assert.throws(() => cache.certify(200, 100), e => e.code === 'ERR_RANGE');
  assert.throws(() => cache.correctRange(0, 10, Buffer.alloc(5)), e => e.code === 'ERR_RANGE');
  assert.throws(() => cache.invalidate(-5, 10), e => e.code === 'ERR_RANGE');

  const cert = cache.certify(0, size);
  // tampered root with intact generations -> ERR_CRC
  assert.throws(() => cache.checkCert({ ...cert, root: '0'.repeat(64) }),
    e => e.code === 'ERR_CRC');
  // malformed bitmap (wrong length for the window) -> ERR_CRC
  assert.throws(() => cache.checkCert({ ...cert, bitmap: 'ffffff' }),
    e => e.code === 'ERR_CRC');
  // window outside the sample -> ERR_RANGE
  assert.throws(() => cache.checkCert({ ...cert, window: [0, 99] }),
    e => e.code === 'ERR_RANGE');
  // certificate issued for another sample -> ERR_CRC
  const other = randomSample(dir, size, 22, 'other.bin');
  const cache2 = SampleCache.ingest(other, { blockSize, cacheDir: path.join(dir, 'c2') });
  const foreign = cache2.certify(0, size);
  assert.throws(() => cache.checkCert(foreign), e => e.code === 'ERR_CRC');
});

test('invalidate drops cached blocks and overlapping certificates', () => {
  const dir = tmpdir();
  const blockSize = 128;
  const size = 1024;
  const sample = randomSample(dir, size, 31);
  const cache = SampleCache.ingest(sample, { blockSize });
  cache.certify(0, 4 * blockSize);
  cache.certify(6 * blockSize, 8 * blockSize);
  assert.deepEqual(cache.listCerts().map(c => c.window), [[0, 4], [6, 8]]);
  const r = cache.invalidate(2 * blockSize, 5 * blockSize); // blocks 2..4
  assert.equal(r.evictedBlocks, 3);
  assert.equal(r.droppedCerts, 1);
  assert.deepEqual(cache.listCerts().map(c => c.window), [[6, 8]]);
  assert.deepEqual(cache.meta.blocks.map(b => b.cached),
    [true, true, false, false, false, true, true, true]);
  // cache still verifies afterwards (reads through from source)
  assert.equal(cache.checkCert(cache.certify(0, size)).ok, true);
});

test('cli: ingest / certify / correctRange / checkCert end to end', () => {
  const dir = tmpdir();
  const sample = randomSample(dir, 1024, 41);
  const certFile = path.join(dir, 'cert.json');
  let r = runCli(['ingest', sample, '--block-size', '128', '--capacity', '4096']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  r = runCli(['certify', sample, '0', '1024', '--out', certFile]);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['checkCert', sample, certFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  r = runCli(['correctRange', sample, '0', '128', '--fill', '7']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['checkCert', sample, certFile]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr.trim()).error, 'ERR_STALE');

  // re-certify restores trust
  r = runCli(['certify', sample, '0', '1024', '--out', certFile]);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['checkCert', sample, certFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('cli: merge adjacent certs, keep overlapping ones side by side', () => {
  const dir = tmpdir();
  const sample = randomSample(dir, 512, 55);
  assert.equal(runCli(['ingest', sample, '--block-size', '128']).status, 0);
  const f1 = path.join(dir, 'c1.json');
  const f2 = path.join(dir, 'c2.json');
  const f3 = path.join(dir, 'c3.json');
  const fm = path.join(dir, 'merged.json');
  assert.equal(runCli(['certify', sample, '0', '256', '--out', f1]).status, 0);
  assert.equal(runCli(['certify', sample, '256', '512', '--out', f2]).status, 0);
  assert.equal(runCli(['certify', sample, '128', '384', '--out', f3]).status, 0);

  let r = runCli(['merge', sample, f1, f2, '--out', fm]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).merged, true);
  r = runCli(['checkCert', sample, fm]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).window, [0, 4]);

  r = runCli(['merge', sample, f1, f3]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).merged, false);
});
