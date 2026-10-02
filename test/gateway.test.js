'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  merkleRoot, encodeData, encodeEnd, encodeAbort, encodeFrame,
  ManualClock, Gateway, StructureError, ConflictError,
} = require('../lib/gateway');

const CLI = path.join(__dirname, '..', 'cli.js');

// deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeData(len, seed = 42) {
  const r = rng(seed);
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = Math.floor(r() * 256);
  return buf;
}
// split data into random chunks -> [{offset, data}]
function randomChunks(data, rand) {
  const chunks = [];
  let off = 0;
  while (off < data.length) {
    const n = 1 + Math.floor(rand() * Math.min(700, data.length - off));
    chunks.push({ offset: off, data: data.subarray(off, off + n) });
    off += n;
  }
  return chunks;
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function streamOf(board, session, chunks, { retransmit = false, rand = Math.random } = {}) {
  let frames = [];
  let list = shuffle(chunks, rand);
  if (retransmit) {
    // duplicate some fragments (retransmission)
    const extra = list.filter(() => rand() < 0.3);
    list = shuffle(list.concat(extra), rand);
  }
  for (const c of list) frames.push(encodeData(board, session, c.offset, c.data));
  frames.push(encodeEnd(board, session));
  return Buffer.concat(frames);
}
function runCli({ stream, dir, extra = [] }) {
  const s = path.join(dir, 's.bin');
  fs.writeFileSync(s, stream);
  const res = spawnSync(process.execPath,
    [CLI, '--stream', s, '--out', path.join(dir, 'certs.json'), '--log', path.join(dir, 'frames.log'), ...extra]);
  const read = (f) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '';
  return { code: res.status, certs: JSON.parse(read('certs.json') || '[]'), log: read('frames.log') };
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')); }

// 验收1: 分片乱序 + 重传后, Merkle 根与一次性拼装参考一致
test('out-of-order + retransmitted fragments yield reference merkle root', () => {
  const data = makeData(5000);
  const rand = rng(7);
  const chunks = randomChunks(data, rand);
  const stream = streamOf(1, 1, chunks, { retransmit: true, rand });
  const gw = new Gateway({ clock: new ManualClock() });
  gw.feed(stream);
  assert.equal(gw.certs.length, 1);
  const cert = gw.certs[0];
  assert.equal(cert.status, 'committed');
  assert.equal(cert.bytesReceived, data.length);
  assert.equal(cert.merkleRoot, merkleRoot(data)); // one-shot reference
  assert.ok(gw.events.some((e) => e.includes('dup')), 'retransmits deduped by offset');
});

// 验收2: 半帧重启不污染已完成证书
test('half frame + restart does not pollute completed certs', () => {
  const dir = tmp();
  const data = makeData(2048);
  const good = streamOf(1, 1, randomChunks(data, rng(1)), { rand: rng(2) });
  const halfFrame = encodeData(2, 1, 0, makeData(100)).subarray(0, 9); // truncated
  let r = runCli({ stream: Buffer.concat([good, halfFrame]), dir });
  assert.equal(r.code, 0);
  assert.equal(r.certs.length, 1);
  const certBefore = JSON.stringify(r.certs[0]);
  assert.equal(r.certs[0].merkleRoot, merkleRoot(data));

  // restart: new stream for board 2, same certs.json
  const data2 = makeData(1500, 9);
  r = runCli({ stream: streamOf(2, 1, randomChunks(data2, rng(3)), { rand: rng(4) }), dir });
  assert.equal(r.code, 0);
  assert.equal(r.certs.length, 2);
  assert.equal(JSON.stringify(r.certs[0]), certBefore, 'completed cert untouched');
  assert.equal(r.certs[1].board, 2);
  assert.equal(r.certs[1].merkleRoot, merkleRoot(data2));
});

// 验收3: 同 session 冲突拒绝(exit 6)且保留旧证
test('same-session conflict is rejected with exit 6 and old cert preserved', () => {
  const dir = tmp();
  const data = makeData(1000);
  let r = runCli({ stream: streamOf(1, 1, randomChunks(data, rng(5)), { rand: rng(6) }), dir });
  assert.equal(r.code, 0);
  const certBefore = JSON.stringify(r.certs);

  // new DATA on same board with same session -> conflict
  r = runCli({ stream: encodeData(1, 1, 0, makeData(10)), dir });
  assert.equal(r.code, 6);
  assert.equal(JSON.stringify(r.certs), certBefore, 'old cert preserved');
  assert.ok(r.log.includes('conflict'));

  // in-process: conflict throws ConflictError
  const gw = new Gateway({ clock: new ManualClock() });
  gw.feed(streamOf(1, 1, randomChunks(data, rng(5)), { rand: rng(6) }));
  assert.throws(() => gw.feed(encodeData(1, 1, 0, Buffer.from('x'))), ConflictError);
});

// 验收4: 随机切分与枚举 offset 对照 -> 同一 Merkle 根
test('random chunking matches enumerated-offset reference root', () => {
  for (let iter = 0; iter < 50; iter++) {
    const rand = rng(1000 + iter);
    const len = 1 + Math.floor(rand() * 8000);
    const data = makeData(len, 500 + iter);
    // reference: enumerated fixed 64-byte offsets
    const ref = [];
    for (let off = 0; off < data.length; off += 64) {
      ref.push({ offset: off, data: data.subarray(off, Math.min(off + 64, data.length)) });
    }
    const gwRef = new Gateway({ clock: new ManualClock() });
    gwRef.feed(streamOf(1, 1, ref, { rand }));
    // random chunking, shuffled, with retransmits
    const gwRand = new Gateway({ clock: new ManualClock() });
    gwRand.feed(streamOf(1, 1, randomChunks(data, rand), { retransmit: true, rand }));
    assert.equal(gwRand.certs[0].merkleRoot, gwRef.certs[0].merkleRoot, `iter=${iter} len=${len}`);
    assert.equal(gwRand.certs[0].merkleRoot, merkleRoot(data));
    assert.equal(gwRand.certs[0].bytesReceived, len);
  }
});

test('bad crc is logged and skipped without terminating', () => {
  const data = makeData(300);
  const bad = encodeData(1, 1, 0, data.subarray(0, 100));
  bad[bad.length - 1] ^= 0xff; // corrupt crc
  const stream = Buffer.concat([
    bad,
    encodeData(1, 1, 0, data.subarray(0, 100)), // retransmit good copy
    encodeData(1, 1, 100, data.subarray(100)),
    encodeEnd(1, 1),
  ]);
  const gw = new Gateway({ clock: new ManualClock() });
  gw.feed(stream);
  assert.equal(gw.certs[0].merkleRoot, merkleRoot(data));
  assert.ok(gw.events.some((e) => e.startsWith('t=0 bad_crc')));
});

test('structure error exits 2', () => {
  const dir = tmp();
  // garbage magic
  let r = runCli({ stream: Buffer.from([0x00, 0x11, 0x22]), dir });
  assert.equal(r.code, 2);
  // unknown type with valid crc
  const p = Buffer.alloc(2);
  const unknown = encodeFrame(0x7f, 1, p);
  r = runCli({ stream: unknown, dir });
  assert.equal(r.code, 2);
  // in-process
  const gw = new Gateway({ clock: new ManualClock() });
  assert.throws(() => gw.feed(Buffer.from([0xde, 0xad])), StructureError);
});

test('ABORT after END is ignored; after ABORT session must increment', () => {
  const data = makeData(500);
  const gw = new Gateway({ clock: new ManualClock() });
  gw.feed(streamOf(1, 1, randomChunks(data, rng(11)), { rand: rng(12) }));
  // ABORT for already-ENDed board: ignored, cert kept
  gw.feed(encodeAbort(1, 1, 'late abort'));
  assert.equal(gw.certs.length, 1);
  assert.equal(gw.certs[0].status, 'committed');
  assert.ok(gw.events.some((e) => e.includes('abort_ignored')));

  // abort board 2 session 3, then reuse session 3 -> conflict
  gw.feed(Buffer.concat([encodeData(2, 3, 0, makeData(10)), encodeAbort(2, 3, 'nozzle jam')]));
  assert.equal(gw.certs[1].status, 'aborted');
  assert.equal(gw.certs[1].discardReason, 'nozzle jam');
  assert.equal(gw.certs[1].bytesReceived, 10);
  assert.throws(() => gw.feed(encodeData(2, 3, 0, makeData(5))), ConflictError);
  // incremented session works
  const d2 = makeData(200, 77);
  gw.feed(Buffer.concat([encodeData(2, 4, 0, d2), encodeEnd(2, 4)]));
  assert.equal(gw.certs[2].merkleRoot, merkleRoot(d2));
});

test('missing fragment timeout emits retransmit request; clock pausable', () => {
  const clock = new ManualClock();
  const gw = new Gateway({ clock, timeoutMs: 100 });
  gw.feed(encodeData(1, 1, 0, makeData(50)));
  gw.feed(encodeData(1, 1, 150, makeData(50))); // gap at offset 50
  clock.pause();
  clock.advance(1000); // paused: no time passes
  gw.checkTimeouts();
  assert.ok(!gw.events.some((e) => e.includes('retransmit_request')));
  clock.resume();
  clock.advance(150);
  gw.checkTimeouts();
  const req = gw.events.find((e) => e.includes('retransmit_request'));
  assert.ok(req, 'retransmit requested after timeout');
  assert.ok(req.includes('missing_offsets=50'));
});

test('frames.log and certs.json are written by CLI', () => {
  const dir = tmp();
  const data = makeData(800);
  const r = runCli({ stream: streamOf(3, 1, randomChunks(data, rng(21)), { rand: rng(22) }), dir });
  assert.equal(r.code, 0);
  assert.ok(r.log.includes('commit board=3'));
  assert.equal(r.certs[0].board, 3);
  assert.deepEqual(Object.keys(r.certs[0]).sort(),
    ['board', 'bytesReceived', 'discardReason', 'merkleRoot', 'session', 'status']);
});
