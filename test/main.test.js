'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  build,
  open,
  verifyIndex,
  repair,
  crc32c,
  constants,
} = require('../index');

// 确定性伪随机, 保证测试可复现
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWorkspace(name, srcSize, { blockSize = 1024, interval = 8 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rs-${name}-`));
  const src = path.join(dir, 'src.bin');
  const data = path.join(dir, 'data.bin');
  const idx = path.join(dir, 'data.idx');
  const rand = mulberry32(0xC0FFEE);
  const buf = Buffer.allocUnsafe(srcSize);
  for (let i = 0; i < srcSize; i++) buf[i] = Math.floor(rand() * 256);
  fs.writeFileSync(src, buf);
  build(src, data, idx, { blockSize, interval });
  return { dir, src, data, idx, srcBuf: buf, blockSize, interval };
}

function expectCode(code, fn) {
  assert.throws(fn, (e) => e.code === code, `expected ${code}`);
}

// ---------- 验收 1: 随机区间 vs 暴力顺序扫描(源文件切片) ----------
test('random ranges match brute-force slice of source', () => {
  const ws = makeWorkspace('ranges', 100003, { blockSize: 1024, interval: 8 });
  const h = open(ws.data, ws.idx);
  try {
    const rand = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const offset = Math.floor(rand() * ws.srcBuf.length);
      const len = Math.floor(rand() * (ws.srcBuf.length - offset + 1));
      assert.deepEqual(h.read(offset, len), ws.srcBuf.subarray(offset, offset + len), `offset=${offset} len=${len}`);
    }
    // 边界: 全量 / 单字节 / 零长 / 跨块
    assert.deepEqual(h.read(0, ws.srcBuf.length), ws.srcBuf);
    assert.deepEqual(h.read(ws.srcBuf.length - 1, 1), ws.srcBuf.subarray(-1));
    assert.equal(h.read(7, 0).length, 0);
    assert.deepEqual(h.read(1000, 2048), ws.srcBuf.subarray(1000, 3048));
  } finally {
    h.close();
  }
});

test('out-of-range reads return ERR_RANGE, never empty', () => {
  const ws = makeWorkspace('range-err', 5000, { blockSize: 512, interval: 4 });
  const h = open(ws.data, ws.idx);
  try {
    expectCode('ERR_RANGE', () => h.read(5000, 1));
    expectCode('ERR_RANGE', () => h.read(4999, 2));
    expectCode('ERR_RANGE', () => h.read(5001, 0));
    expectCode('ERR_RANGE', () => h.read(-1, 10));
    expectCode('ERR_RANGE', () => h.read(0, -5));
    expectCode('ERR_RANGE', () => h.read(0, 5001));
  } finally {
    h.close();
  }
});

// ---------- 验收 2: 翻转索引位图能检出 ----------
test('flipping index bloom bitmap is detected by verifyIndex', () => {
  const ws = makeWorkspace('tamper', 20000, { blockSize: 1024, interval: 4 });
  verifyIndex(ws.data, ws.idx); // 原始: 通过

  const idxBuf = fs.readFileSync(ws.idx);
  // 第一个检查点 bloom 起始 = 头部44 + blockIndex8 + fileOffset8 + prefixHash4
  const bloomOff = constants.INDEX_HEADER_SIZE + 8 + 8 + 4;
  idxBuf[bloomOff] ^= 0xff;
  idxBuf[bloomOff + 10] ^= 0x01;
  fs.writeFileSync(ws.idx, idxBuf);
  expectCode('ERR_INDEX', () => verifyIndex(ws.data, ws.idx));

  // 篡改 prefixHash 同样检出
  const ws2 = makeWorkspace('tamper2', 20000, { blockSize: 1024, interval: 4 });
  const idx2 = fs.readFileSync(ws2.idx);
  idx2[constants.INDEX_HEADER_SIZE + 16] ^= 0x5a;
  fs.writeFileSync(ws2.idx, idx2);
  expectCode('ERR_INDEX', () => verifyIndex(ws2.data, ws2.idx));
});

test('bloom negative yields ERR_BLOOM miss without touching data', () => {
  const ws = makeWorkspace('bloom', 8192, { blockSize: 1024, interval: 4 });
  // 构造一个 bloom 被清零但 CRC 合法的索引: 阴性必须直接 miss
  const idx = fs.readFileSync(ws.idx);
  const entryOff = constants.INDEX_HEADER_SIZE;
  idx.fill(0, entryOff + 20, entryOff + 20 + constants.BLOOM_BYTES);
  idx.writeUInt32LE(crc32c(idx.subarray(entryOff, entryOff + constants.CHECKPOINT_SIZE - 4)), entryOff + constants.CHECKPOINT_SIZE - 4);
  idx.writeUInt32LE(crc32c(idx.subarray(0, idx.length - 4)), idx.length - 4);
  fs.writeFileSync(ws.idx, idx);
  const h = open(ws.data, ws.idx);
  try {
    expectCode('ERR_BLOOM', () => h.read(0, 1)); // 块 0 属于检查点 0
  } finally {
    h.close();
  }
});

// ---------- 验收 3: 删除末块后读边界行为确定 ----------
test('truncated data (last block removed) has deterministic boundary behavior', () => {
  const blockSize = 512;
  const interval = 4;
  const ws = makeWorkspace('trunc', blockSize * 10 + 100, { blockSize, interval }); // 11 块
  // 末块 = 16 字节头 + 100 字节载荷
  fs.truncateSync(ws.data, fs.statSync(ws.data).size - (constants.BLOCK_HEADER_SIZE + 100));

  const h = open(ws.data, ws.idx);
  try {
    // 完整保留区域: 正常
    assert.deepEqual(h.read(0, blockSize), ws.srcBuf.subarray(0, blockSize));
    assert.deepEqual(h.read(blockSize * 9, blockSize), ws.srcBuf.subarray(blockSize * 9, blockSize * 10));
    // 触及被删末块: 确定地 ERR_INDEX (而非空/未定义)
    expectCode('ERR_INDEX', () => h.read(blockSize * 10, 50));
    expectCode('ERR_INDEX', () => h.read(5000, 200)); // 5000+200=5200 <= 旧dataSize 5220, 但跨入已删末块
    // 越界仍是 ERR_RANGE (索引尚未修复, dataSize 含已删块)
    expectCode('ERR_RANGE', () => h.read(blockSize * 10 + 100, 1));
  } finally {
    h.close();
  }
  expectCode('ERR_INDEX', () => verifyIndex(ws.data, ws.idx));

  // repair 后: 索引反映截断后的数据, 原末块区间变为 ERR_RANGE
  repair(ws.data, ws.idx);
  const h2 = open(ws.data, ws.idx);
  try {
    assert.equal(h2.dataSize, blockSize * 10);
    assert.deepEqual(h2.read(blockSize * 9, blockSize), ws.srcBuf.subarray(blockSize * 9, blockSize * 10));
    expectCode('ERR_RANGE', () => h2.read(blockSize * 10, 50));
  } finally {
    h2.close();
  }
  assert.equal(verifyIndex(ws.data, ws.idx), true);
});

// ---------- 验收 4: N=1 与 N 大于块数 ----------
test('interval N=1 (checkpoint per block)', () => {
  const ws = makeWorkspace('n1', 10000, { blockSize: 512, interval: 1 });
  const h = open(ws.data, ws.idx);
  try {
    assert.equal(h.blockCount, Math.ceil(10000 / 512));
    const rand = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const offset = Math.floor(rand() * 10000);
      const len = Math.floor(rand() * (10000 - offset + 1));
      assert.deepEqual(h.read(offset, len), ws.srcBuf.subarray(offset, offset + len));
    }
  } finally {
    h.close();
  }
  assert.equal(verifyIndex(ws.data, ws.idx), true);
});

test('interval N greater than blockCount (single checkpoint)', () => {
  const ws = makeWorkspace('nbig', 2500, { blockSize: 1024, interval: 100 }); // 3 块, 1 检查点
  const h = open(ws.data, ws.idx);
  try {
    assert.equal(h.blockCount, 3);
    assert.deepEqual(h.read(0, 2500), ws.srcBuf);
    assert.deepEqual(h.read(1023, 2), ws.srcBuf.subarray(1023, 1025));
    expectCode('ERR_RANGE', () => h.read(2500, 1));
  } finally {
    h.close();
  }
  assert.equal(verifyIndex(ws.data, ws.idx), true);
});

test('interval N=1 with single block and empty file edge cases', () => {
  const ws = makeWorkspace('single', 100, { blockSize: 1024, interval: 1 });
  const h = open(ws.data, ws.idx);
  try {
    assert.deepEqual(h.read(0, 100), ws.srcBuf);
    expectCode('ERR_RANGE', () => h.read(100, 1));
  } finally {
    h.close();
  }
  const empty = makeWorkspace('empty', 0, { blockSize: 1024, interval: 1 });
  const h2 = open(empty.data, empty.idx);
  try {
    assert.equal(h2.read(0, 0).length, 0);
    expectCode('ERR_RANGE', () => h2.read(0, 1));
  } finally {
    h2.close();
  }
  assert.equal(verifyIndex(empty.data, empty.idx), true);
});

// ---------- 验收 5: repair 后索引字节可复现 ----------
test('repair reproduces index bytes exactly and deterministically', () => {
  const ws = makeWorkspace('repair', 50000, { blockSize: 777, interval: 5 });
  const original = fs.readFileSync(ws.idx);

  // 破坏索引: 翻字节 + 截断
  const corrupted = Buffer.from(original);
  corrupted[50] ^= 0xaa;
  fs.writeFileSync(ws.idx, corrupted.subarray(0, corrupted.length - 30));
  expectCode('ERR_INDEX', () => verifyIndex(ws.data, ws.idx));

  repair(ws.data, ws.idx);
  assert.deepEqual(fs.readFileSync(ws.idx), original, 'repair must reproduce original index bytes');

  repair(ws.data, ws.idx); // 幂等
  assert.deepEqual(fs.readFileSync(ws.idx), original);
  assert.equal(verifyIndex(ws.data, ws.idx), true);

  // 数据未被 repair 修改
  const h = open(ws.data, ws.idx);
  try {
    assert.deepEqual(h.read(0, ws.srcBuf.length), ws.srcBuf);
  } finally {
    h.close();
  }
});

// ---------- 数据损坏: ERR_CRC ----------
test('corrupted payload yields ERR_CRC on read and verify', () => {
  const ws = makeWorkspace('crc', 4096, { blockSize: 1024, interval: 2 });
  // 翻块 1 载荷首字节: 数据头16 + 块0(16+1024) + 块1头16 = 1056+16
  const payloadOff = constants.DATA_HEADER_SIZE + constants.BLOCK_HEADER_SIZE + 1024 + constants.BLOCK_HEADER_SIZE;
  const fd = fs.openSync(ws.data, 'r+');
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, payloadOff);
  b[0] ^= 0xff;
  fs.writeSync(fd, b, 0, 1, payloadOff);
  fs.closeSync(fd);

  const h = open(ws.data, ws.idx);
  try {
    expectCode('ERR_CRC', () => h.read(1024, 10));
    assert.deepEqual(h.read(0, 1024), ws.srcBuf.subarray(0, 1024)); // 未损坏块仍可读
  } finally {
    h.close();
  }
  expectCode('ERR_CRC', () => verifyIndex(ws.data, ws.idx));
});

// ---------- CLI 端到端 (进程内调用 run, 等价于 node cli.js ...) ----------
test('CLI: build/read/verify/repair with JSON errors on stderr', () => {
  const { run } = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cli-'));
  const src = path.join(dir, 'src.bin');
  const data = path.join(dir, 'data.bin');
  const idx = path.join(dir, 'data.idx');
  const rand = mulberry32(99);
  const srcBuf = Buffer.allocUnsafe(5000);
  for (let i = 0; i < srcBuf.length; i++) srcBuf[i] = Math.floor(rand() * 256);
  fs.writeFileSync(src, srcBuf);

  const mkIo = () => {
    const out = { stdout: [], stderr: [] };
    const io = {
      stdout: (b) => out.stdout.push(Buffer.isBuffer(b) ? b : Buffer.from(b)),
      stderr: (s) => out.stderr.push(Buffer.from(s)),
    };
    return { out, io };
  };
  const cli = (...args) => {
    const { out, io } = mkIo();
    const status = run([process.execPath, 'cli.js', ...args], io);
    return {
      status,
      stdout: Buffer.concat(out.stdout),
      stderr: Buffer.concat(out.stderr).toString(),
    };
  };

  const b = cli('build', src, data, idx, '256', '3');
  assert.equal(b.status, 0);
  assert.equal(JSON.parse(b.stdout.toString()).ok, true);

  const ok = cli('read', data, idx, '100', '37');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout, srcBuf.subarray(100, 137));

  const oob = cli('read', data, idx, '4990', '37');
  assert.equal(oob.status, 1);
  assert.equal(JSON.parse(oob.stderr).error, 'ERR_RANGE');

  const ver = cli('verify', data, idx);
  assert.equal(ver.status, 0);
  assert.equal(JSON.parse(ver.stdout.toString()).ok, true);

  // 改索引 -> verify 失败(ERR_INDEX) -> repair -> verify 通过且字节复现
  const originalIdx = fs.readFileSync(idx);
  const idxBuf = Buffer.from(originalIdx);
  idxBuf[constants.INDEX_HEADER_SIZE + 5] ^= 0x01;
  fs.writeFileSync(idx, idxBuf);
  const bad = cli('verify', data, idx);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error, 'ERR_INDEX');

  const rep = cli('repair', data, idx);
  assert.equal(rep.status, 0, rep.stderr);
  assert.equal(JSON.parse(rep.stdout.toString()).ok, true);
  assert.deepEqual(fs.readFileSync(idx), originalIdx);
  assert.equal(cli('verify', data, idx).status, 0);
});
