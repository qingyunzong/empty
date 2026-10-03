'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../index');
const { run } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rse-'));
}

function makeRaw(dir, size, seed = 1) {
  // Deterministic pseudo-random bytes (xorshift32).
  const buf = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  const f = path.join(dir, 'src.bin');
  fs.writeFileSync(f, buf);
  return { f, buf };
}

// In-process CLI invocation capturing stdout/stderr (sandbox forbids spawning).
function cli(args) {
  const out = [];
  const err = [];
  const code = run(args, {
    out: (b) => out.push(Buffer.isBuffer(b) ? b : Buffer.from(b)),
    err: (s) => err.push(String(s)),
  });
  return {
    code,
    stdout: Buffer.concat(out),
    stderr: err.join(''),
    stderrJson() {
      return JSON.parse(this.stderr.trim().split('\n').pop());
    },
  };
}

test('1. random intervals match brute-force sequential scan', () => {
  const dir = tmpdir();
  const { f, buf } = makeRaw(dir, 100000, 42);
  const data = path.join(dir, 'data.rse');
  const idx = path.join(dir, 'data.ridx');
  lib.build(f, data, idx, { blockSize: 128, n: 4 });

  const h = lib.open(data, idx);
  try {
    let rng = 7;
    const next = () => { rng = (rng * 1103515245 + 12345) >>> 0; return rng; };
    for (let i = 0; i < 500; i++) {
      const offset = next() % buf.length;
      const len = (next() % Math.min(2000, buf.length - offset)) + 1;
      const got = h.read(offset, len);
      assert.ok(Buffer.isBuffer(got), `read ${offset} ${len} returned null`);
      assert.deepStrictEqual(got, buf.subarray(offset, offset + len), `mismatch at ${offset}+${len}`);
    }
    // Edge ranges.
    assert.deepStrictEqual(h.read(0, buf.length), buf);
    assert.deepStrictEqual(h.read(buf.length - 1, 1), buf.subarray(-1));
    assert.deepStrictEqual(h.read(0, 0), Buffer.alloc(0));
  } finally {
    h.close();
  }
});

test('2. flipped index bitmap is detected (verify fails, bloom miss)', () => {
  const dir = tmpdir();
  const { f } = makeRaw(dir, 4096, 3);
  const data = path.join(dir, 'data.rse');
  const idx = path.join(dir, 'data.ridx');
  lib.build(f, data, idx, { blockSize: 64, n: 2 });

  // Zero out checkpoint 0's bloom bitmap (flip every set bit).
  const buf = fs.readFileSync(idx);
  const bloomBits = buf.readUInt32LE(28);
  const bloomOff = lib.IDX_HEADER_SIZE + lib.CP_FIXED_SIZE;
  buf.fill(0, bloomOff, bloomOff + bloomBits / 8);
  fs.writeFileSync(idx, buf);

  // verifyIndex must fail with ERR_INDEX.
  const v = cli(['verify', data, idx]);
  assert.notStrictEqual(v.code, 0);
  assert.strictEqual(v.stderrJson().error, 'ERR_INDEX');

  // read must short-circuit on bloom negative: ERR_BLOOM, no data on stdout.
  const r = cli(['read', data, idx, '0', '37']);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.stderrJson().error, 'ERR_BLOOM');
  assert.strictEqual(r.stdout.length, 0);
});

test('3. deleting the last block gives deterministic boundary behavior', () => {
  const dir = tmpdir();
  const { f, buf } = makeRaw(dir, 1000, 9);
  const data = path.join(dir, 'data.rse');
  const idx = path.join(dir, 'data.ridx');
  lib.build(f, data, idx, { blockSize: 100, n: 3 });

  const h = lib.open(data, idx);
  const { blockSize, blockCount, dataSize } = h.meta;
  h.close();
  const lastLen = dataSize - (blockCount - 1) * blockSize;

  // Truncate away the last block (header + payload).
  const stat = fs.statSync(data);
  fs.truncateSync(data, stat.size - (lib.BLOCK_HEADER_SIZE + lastLen));

  // Reads fully before the deleted block still succeed.
  const ok = cli(['read', data, idx, '0', String(dataSize - lastLen)]);
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.deepStrictEqual(ok.stdout, buf.subarray(0, dataSize - lastLen));

  // Reads touching the deleted block deterministically fail with ERR_CRC.
  for (const [off, len] of [[dataSize - lastLen, 1], [dataSize - 1, 1], [dataSize - lastLen, lastLen]]) {
    const r = cli(['read', data, idx, String(off), String(len)]);
    assert.notStrictEqual(r.code, 0);
    assert.strictEqual(r.stderrJson().error, 'ERR_CRC', `offset=${off}`);
  }
});

test('4. boundary N values: N=1 and N greater than block count', () => {
  const dir = tmpdir();
  const { f, buf } = makeRaw(dir, 300, 5);
  const data = path.join(dir, 'data.rse');
  const idx = path.join(dir, 'data.ridx');

  // N = 1: checkpoint for every block.
  lib.build(f, data, idx, { blockSize: 100, n: 1 });
  let h = lib.open(data, idx);
  assert.strictEqual(h.meta.checkpoints.length, 3);
  assert.deepStrictEqual(h.read(50, 200), buf.subarray(50, 250));
  assert.strictEqual(h.verifyIndex(), true);
  h.close();

  // N far larger than block count: single checkpoint.
  lib.build(f, data, idx, { blockSize: 100, n: 1000 });
  h = lib.open(data, idx);
  assert.strictEqual(h.meta.checkpoints.length, 1);
  assert.deepStrictEqual(h.read(0, 300), buf);
  assert.deepStrictEqual(h.read(299, 1), buf.subarray(299));
  assert.strictEqual(h.verifyIndex(), true);
  h.close();
});

test('5. repair after index tampering reproduces identical index bytes', () => {
  const dir = tmpdir();
  const { f, buf: raw } = makeRaw(dir, 5000, 11);
  const data = path.join(dir, 'data.rse');
  const idx = path.join(dir, 'data.ridx');
  lib.build(f, data, idx, { blockSize: 128, n: 4 });

  const original = fs.readFileSync(idx);
  const dataBefore = fs.readFileSync(data);

  // Tamper: flip a byte inside the index.
  const tampered = Buffer.from(original);
  tampered[20] ^= 0xff;
  fs.writeFileSync(idx, tampered);

  // verifyIndex fails while data is intact.
  const v = cli(['verify', data, idx]);
  assert.strictEqual(v.stderrJson().error, 'ERR_INDEX');

  // repair rebuilds from data; bytes are reproducible.
  lib.repair(data, idx);
  const repaired1 = fs.readFileSync(idx);
  assert.deepStrictEqual(repaired1, original);
  lib.repair(data, idx);
  assert.deepStrictEqual(fs.readFileSync(idx), repaired1);

  // Data file untouched, reads still correct.
  assert.deepStrictEqual(fs.readFileSync(data), dataBefore);
  const h = lib.open(data, idx);
  assert.deepStrictEqual(h.read(100, 37), raw.subarray(100, 137));
  assert.strictEqual(h.verifyIndex(), true);
  h.close();
});

test('out-of-range reads return ERR_RANGE, never empty success', () => {
  const dir = tmpdir();
  const { f } = makeRaw(dir, 500, 13);
  const data = path.join(dir, 'data.rse');
  const idx = path.join(dir, 'data.ridx');
  lib.build(f, data, idx, { blockSize: 64, n: 2 });

  for (const [off, len] of [[500, 1], [499, 2], [-1, 5], [0, 501], [100000, 10]]) {
    const r = cli(['read', data, idx, String(off), String(len)]);
    assert.notStrictEqual(r.code, 0, `offset=${off} len=${len}`);
    const body = r.stderrJson();
    assert.strictEqual(body.error, 'ERR_RANGE', `offset=${off} len=${len}`);
    assert.strictEqual(body.dataSize, 500);
    assert.strictEqual(r.stdout.length, 0);
  }
});

test('corrupt block payload fails with ERR_CRC', () => {
  const dir = tmpdir();
  const { f } = makeRaw(dir, 256, 17);
  const data = path.join(dir, 'data.rse');
  const idx = path.join(dir, 'data.ridx');
  lib.build(f, data, idx, { blockSize: 64, n: 2 });

  // Flip one payload byte in block 1 (second block).
  const fd = fs.openSync(data, 'r+');
  const pos = lib.BLOCK_HEADER_SIZE + 64 + lib.BLOCK_HEADER_SIZE + 10;
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, pos);
  b[0] ^= 0x01;
  fs.writeSync(fd, b, 0, 1, pos);
  fs.closeSync(fd);

  const r = cli(['read', data, idx, '70', '10']);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.stderrJson().error, 'ERR_CRC');
});

test('CLI flow: build + read 100 37 + verify', () => {
  const dir = tmpdir();
  const { f, buf } = makeRaw(dir, 1000, 23);
  const data = path.join(dir, 'f');
  const idx = path.join(dir, 'idx');
  assert.strictEqual(cli(['build', f, data, idx, '64', '4']).code, 0);
  const r = cli(['read', data, idx, '100', '37']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.stdout, buf.subarray(100, 137));
  const v = cli(['verify', data, idx]);
  assert.strictEqual(v.code, 0);
  assert.strictEqual(JSON.parse(v.stdout.toString()).ok, true);
});
