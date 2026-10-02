'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wx = require('../lib/wxblk');
const { crc32c } = require('../lib/crc32c');
const cli = require('../cli');

let tmpCount = 0;
function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wxblk-')), `t${tmpCount++}.wx`);
}
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = cli.run(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { status, stdout, stderr };
}

test('crc32c known vector', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

// Acceptance 1: append -> correct -> undo, decode equals enumerated reference.
test('acceptance 1: append-correct-undo decode matches reference', () => {
  const f = tmpFile();
  wx.append(f, 'temp=20.1', { ts: 1000 });
  wx.append(f, 'temp=20.4', { ts: 2000 });
  wx.append(f, 'temp=20.9', { ts: 3000 });

  assert.deepEqual(wx.decode(f).map((r) => r.payload),
    ['temp=20.1', 'temp=20.4', 'temp=20.9']);

  const c = wx.correct(f, 1, 'temp=21.4', { ts: 4000 });
  assert.equal(c.type, 'correction');
  assert.deepEqual(wx.decode(f).map((r) => r.payload),
    ['temp=20.1', 'temp=21.4', 'temp=20.9']);

  wx.undo(f, c.blockId, { ts: 5000 });
  const view = wx.decode(f);
  assert.deepEqual(view.map((r) => r.payload),
    ['temp=20.1', 'temp=20.4', 'temp=20.9']);
  assert.deepEqual(view.map((r) => r.corrected), [false, false, false]);

  // range decode
  assert.deepEqual(wx.decode(f, { from: 1, to: 2 }).map((r) => r.payload),
    ['temp=20.4', 'temp=20.9']);
  assert.throws(() => wx.decode(f, { from: 2, to: 1 }), (e) => e.code === 'ERR_RANGE');
  assert.throws(() => wx.decode(f, { from: 0, to: 9 }), (e) => e.code === 'ERR_RANGE');
});

// undo conflict: a correction depended on by another correction cannot be undone.
test('undo of depended-on correction fails with ERR_CONFLICT', () => {
  const f = tmpFile();
  wx.append(f, 'v0', { ts: 1 });
  const c1 = wx.correct(f, 0, 'v1', { ts: 2 });
  const c2 = wx.correct(f, c1.blockId, 'v2', { ts: 3 });
  assert.throws(() => wx.undo(f, c1.blockId), (e) => e.code === 'ERR_CONFLICT');
  // undo in reverse dependency order works
  wx.undo(f, c2.blockId, { ts: 4 });
  wx.undo(f, c1.blockId, { ts: 5 });
  assert.deepEqual(wx.decode(f).map((r) => r.payload), ['v0']);
  // double undo conflicts
  assert.throws(() => wx.undo(f, c1.blockId), (e) => e.code === 'ERR_CONFLICT');
  // unknown ids
  assert.throws(() => wx.undo(f, 99), (e) => e.code === 'ERR_RANGE');
  assert.throws(() => wx.correct(f, 99, 'x'), (e) => e.code === 'ERR_RANGE');
});

// Acceptance 2: random byte flip is located to the exact block.
test('acceptance 2: flipped byte located by block number', () => {
  const f = tmpFile();
  for (let i = 0; i < 5; i++) wx.append(f, `observation-${i}`, { ts: 1000 + i });
  const scan0 = wx.scan(f);
  const target = scan0.blocks[2]; // physical block #2
  const buf = fs.readFileSync(f);
  const flipAt = target.offset + wx.HEADER_LEN + 3; // inside payload
  buf[flipAt] ^= 0xff;
  fs.writeFileSync(f, buf);

  const scan = wx.scan(f);
  assert.equal(scan.blocks[2].crcOk, false);
  assert.equal(scan.blocks.filter((b) => !b.crcOk).length, 1);

  // CLI verify: non-zero exit, stderr JSON locates block 2
  const r = runCli(['verify', f]);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'ERR_CHAIN');
  assert.deepEqual(err.details.crcErrors.map((e) => e.block), [2]);
  assert.equal(err.details.crcErrors[0].offset, target.offset);
});

// Acceptance 3: truncation mid-block vs at block boundary -> different, deterministic recovery.
test('acceptance 3: truncation recovery differs deterministically', () => {
  const f = tmpFile();
  for (let i = 0; i < 4; i++) wx.append(f, `rec-${i}`, { ts: 10 + i });
  const full = fs.readFileSync(f);
  const scan0 = wx.scan(f);
  const b2 = scan0.blocks[2];

  // mid-block truncation: cut inside block 2's payload
  const mid = tmpFile();
  fs.writeFileSync(mid, full.subarray(0, b2.offset + wx.HEADER_LEN + 2));
  // boundary truncation: cut exactly after block 1 (block 2 fully gone)
  const boundary = tmpFile();
  fs.writeFileSync(boundary, full.subarray(0, b2.offset));

  const decodeMid = () => wx.decode(mid).map((r) => r.payload);
  const decodeBoundary = () => wx.decode(boundary).map((r) => r.payload);
  assert.deepEqual(decodeMid(), ['rec-0', 'rec-1']);
  assert.deepEqual(decodeBoundary(), ['rec-0', 'rec-1']);
  // deterministic: repeated scans give identical results
  assert.deepEqual(decodeMid(), decodeMid());
  assert.deepEqual(decodeBoundary(), decodeBoundary());

  // ...but the scan reports differ: mid-block cut leaves a truncated tail
  const scanMid = wx.scan(mid);
  const scanBoundary = wx.scan(boundary);
  assert.equal(scanMid.truncated.reason, 'partial-payload');
  assert.equal(scanMid.truncated.offset, b2.offset);
  assert.equal(scanBoundary.truncated, null);
  assert.notDeepEqual(scanMid, scanBoundary);

  // cut exactly at a block boundary *inside* the stream keeps the prefix intact
  const b3 = scan0.blocks[3];
  const boundary2 = tmpFile();
  fs.writeFileSync(boundary2, full.subarray(0, b3.offset));
  assert.deepEqual(wx.decode(boundary2).map((r) => r.payload), ['rec-0', 'rec-1', 'rec-2']);
  assert.equal(wx.scan(boundary2).truncated, null);
});

// Damaged index footer is rebuilt from block scan and the diff is reported.
test('index footer corruption is rebuilt and reported', () => {
  const f = tmpFile();
  for (let i = 0; i < 3; i++) wx.append(f, `r${i}`, { ts: i });
  const scan0 = wx.scan(f);
  const b1 = scan0.blocks[1];
  const buf = fs.readFileSync(f);
  // footer of block 1 sits after header+payload+crc; corrupt its stored offset
  const footerOff = b1.offset + b1.blockLen;
  buf.writeBigUInt64LE(0xdeadn, footerOff + 8);
  fs.writeFileSync(f, buf);

  const scan = wx.scan(f);
  assert.equal(scan.indexDiffs.length, 1);
  const d = scan.indexDiffs[0];
  assert.equal(d.block, 1);
  assert.equal(d.expected.offset, b1.offset);
  assert.equal(d.actual.offset, 0xdead);
  // rebuilt index still correct
  assert.deepEqual(scan.rebuiltIndex.map((e) => e.offset), scan0.blocks.map((b) => b.offset));
  // data still decodes fine (footer is not part of the CRC'd body)
  assert.deepEqual(wx.decode(f).map((r) => r.payload), ['r0', 'r1', 'r2']);
});

// Acceptance 4: brute-force replay of full history matches final view.
test('acceptance 4: random op replay matches independent model', () => {
  // deterministic PRNG (mulberry32)
  let seed = 0xC0FFEE;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const f = tmpFile();
  // independent in-memory model of the view semantics
  const model = new Map(); // rootId -> { payload, ts }
  const corrections = new Map(); // correctId -> { rootId, payload, ts, active }
  const rootOf = new Map(); // any block id -> rootId
  let ts = 0;

  const recomputeModel = () => {
    // rebuild view: newest active correction per root wins
    for (const [rootId, rec] of model) {
      let best = null;
      for (const c of corrections.values()) {
        if (c.rootId === rootId && c.active && (!best || c.id > best.id)) best = c;
      }
      rec.payload = best ? best.payload : rec.origPayload;
      rec.ts = best ? best.ts : rec.origTs;
    }
  };

  const ops = [];
  for (let i = 0; i < 60; i++) {
    const roll = rnd();
    ts += 1 + Math.floor(rnd() * 10);
    if (roll < 0.5 || model.size === 0) {
      const payload = `obs-${i}`;
      const { blockId: id } = wx.append(f, payload, { ts });
      rootOf.set(id, id);
      model.set(id, { origPayload: payload, origTs: ts, payload, ts });
      ops.push(['append', payload]);
    } else if (roll < 0.8) {
      const ids = [...rootOf.keys()];
      const id = ids[Math.floor(rnd() * ids.length)];
      const payload = `fix-${i}`;
      const r = wx.correct(f, id, payload, { ts });
      const rootId = rootOf.get(id);
      rootOf.set(r.blockId, rootId);
      corrections.set(r.blockId, { id: r.blockId, rootId, payload, ts, active: true });
      ops.push(['correct', id, payload]);
    } else {
      const active = [...corrections.values()].filter((c) => c.active);
      if (active.length === 0) continue;
      const c = active[Math.floor(rnd() * active.length)];
      try {
        wx.undo(f, c.id, { ts });
        c.active = false;
        ops.push(['undo', c.id]);
      } catch (e) {
        assert.equal(e.code, 'ERR_CONFLICT');
      }
    }
    recomputeModel();
  }

  const view = wx.decode(f);
  const expected = [...model.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, r]) => ({ id, payload: r.payload, timestamp: r.ts }));
  assert.deepEqual(view.map((r) => ({ id: r.id, payload: r.payload, timestamp: r.timestamp })), expected);
  assert.ok(ops.length > 40);
  assert.equal(wx.verify(f).ok, true);
});

// verify: format errors and chain breaks
test('verify rejects bad magic and broken chain', () => {
  const f = tmpFile();
  fs.writeFileSync(f, Buffer.from('not a wxblk file'));
  assert.throws(() => wx.verify(f), (e) => e.code === 'ERR_FORMAT');
  const r = runCli(['verify', f]);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error, 'ERR_FORMAT');

  const g = tmpFile();
  for (let i = 0; i < 3; i++) wx.append(g, `x${i}`, { ts: i });
  const scan0 = wx.scan(g);
  const buf = fs.readFileSync(g);
  // corrupt prevHash of block 1 (header offset 40) without touching payload CRC
  buf.fill(0xaa, scan0.blocks[1].offset + 40, scan0.blocks[1].offset + 48);
  fs.writeFileSync(g, buf);
  assert.throws(() => wx.verify(g), (e) => e.code === 'ERR_CHAIN');
});

// CLI end-to-end: append/correct/undo/decode/verify via the command line.
test('cli end-to-end', () => {
  const f = tmpFile();
  let r = runCli(['append', f, '--payload', 'a', '--ts', '1']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['append', f, '--payload', 'b', '--ts', '2']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['correct', f, '--id', '0', '--payload', 'a2', '--ts', '3']);
  assert.equal(r.status, 0, r.stderr);
  const cid = JSON.parse(r.stdout).blockId;
  r = runCli(['decode', f]);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.payload), ['a2', 'b']);
  r = runCli(['undo', f, '--correct-id', String(cid), '--ts', '4']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['decode', f, '--from', '0', '--to', '1']);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.payload), ['a', 'b']);
  r = runCli(['verify', f]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  // bad range -> ERR_RANGE on stderr, non-zero exit
  r = runCli(['decode', f, '--from', '5', '--to', '1']);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error, 'ERR_RANGE');
});
