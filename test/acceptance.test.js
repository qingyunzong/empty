'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');
const fmt = require('../src/format');
const { crc32c } = require('../src/crc32c');
const cli = require('../cli.js');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxblk-acc-'));
  return path.join(dir, name);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function view(file) {
  return store.decode(file).records.map((r) => `${r.rootId}:${r.payload.toString()}`);
}

// ---------------------------------------------------------------------------
// Acceptance 1: append -> correct -> undo, decode equals enumerated reference
// ---------------------------------------------------------------------------
test('acceptance 1: append-correct-undo decode equals enumerated reference', () => {
  const f = tmpFile('acc1.wx');
  store.append(f, 'temp=21.3', { timestamp: 1000 }); // block 0
  store.append(f, 'hum=55', { timestamp: 2000 });    // block 1
  store.append(f, 'wind=3.1', { timestamp: 3000 });  // block 2

  assert.deepEqual(view(f), ['0:temp=21.3', '1:hum=55', '2:wind=3.1']);

  const c1 = store.correct(f, 0, 'temp=20.9');       // block 3 corrects 0
  assert.deepEqual(view(f), ['0:temp=20.9', '1:hum=55', '2:wind=3.1']);

  const c2 = store.correct(f, c1.id, 'temp=20.7');   // block 4 corrects correction 3
  assert.deepEqual(view(f), ['0:temp=20.7', '1:hum=55', '2:wind=3.1']);

  store.undo(f, c2.id);                              // revoke block 4 -> back to c1
  assert.deepEqual(view(f), ['0:temp=20.9', '1:hum=55', '2:wind=3.1']);

  store.undo(f, c1.id);                              // revoke block 3 -> original
  assert.deepEqual(view(f), ['0:temp=21.3', '1:hum=55', '2:wind=3.1']);

  // time-windowed decode on the same history
  const win = store.decode(f, { start: 1500, end: 2500 });
  assert.deepEqual(win.records.map((r) => r.payload.toString()), ['hum=55']);
});

// ---------------------------------------------------------------------------
// Acceptance 2: random byte flip is localised to its block
// ---------------------------------------------------------------------------
test('acceptance 2: flipped payload byte is localised to its block number', () => {
  const rng = mulberry32(20261003);
  const f = tmpFile('acc2.wx');
  for (let i = 0; i < 6; i++) {
    const payload = Buffer.alloc(24);
    for (let j = 0; j < payload.length; j++) payload[j] = Math.floor(rng() * 256);
    store.append(f, payload, { timestamp: (i + 1) * 1000 });
  }
  const before = store.scan(f);
  const victim = before.blocks[Math.floor(rng() * before.blocks.length)];
  const byteOff = victim.offset + fmt.HEADER_LEN + Math.floor(rng() * victim.payloadLength);

  const buf = fs.readFileSync(f);
  buf[byteOff] ^= 0x5a;
  fs.writeFileSync(f, buf);

  const report = store.verify(f);
  const crcWarn = report.warnings.find((w) => w.code === 'ERR_CRC');
  assert.ok(crcWarn, 'expected an ERR_CRC warning');
  assert.equal(crcWarn.id, victim.id);
  assert.equal(crcWarn.index, victim.index);
  // chain is computed over raw bytes as stored, so it survives a payload flip
  assert.equal(report.ok, true);
  // the damaged block is skipped, the rest still decode
  const dec = store.decode(f);
  assert.deepEqual(dec.skippedBlocks, [victim.id]);
  assert.equal(dec.records.length, 5);
});

test('acceptance 2b: a flip anywhere inside a block record names that block', () => {
  const rng = mulberry32(777);
  for (let trial = 0; trial < 10; trial++) {
    const f = tmpFile(`acc2b-${trial}.wx`);
    for (let i = 0; i < 4; i++) store.append(f, `payload-${i}-${trial}`, { timestamp: i + 1 });
    const blocks = store.scan(f).blocks;
    const victim = blocks[Math.floor(rng() * blocks.length)];
    const byteOff = victim.offset + Math.floor(rng() * victim.length);
    const buf = fs.readFileSync(f);
    buf[byteOff] ^= 0x01 << Math.floor(rng() * 8);
    fs.writeFileSync(f, buf);

    const report = store.verify(f);
    const mentioned = []
      .concat(report.warnings, report.errors, report.indexDiffs)
      .some((e) => e.id === victim.id || e.index === victim.index);
    assert.ok(mentioned, `trial ${trial}: flip at ${byteOff} (block ${victim.id}) not localised`);
  }
});

// ---------------------------------------------------------------------------
// Acceptance 3: mid-block vs boundary truncation recover differently, deterministically
// ---------------------------------------------------------------------------
test('acceptance 3: truncation recovery differs between mid-block and boundary cuts', () => {
  const f = tmpFile('acc3.wx');
  for (let i = 0; i < 6; i++) store.append(f, `obs-${i}`, { timestamp: (i + 1) * 1000 });
  const blocks = store.scan(f).blocks;
  const boundary = blocks[4].offset;          // exact start of block 4: 4 whole blocks
  const midBlock = boundary + 37;             // 37 bytes into block 4

  const full = fs.readFileSync(f);

  const fBoundary = tmpFile('acc3-boundary.wx');
  fs.writeFileSync(fBoundary, full.subarray(0, boundary));
  const fMid = tmpFile('acc3-mid.wx');
  fs.writeFileSync(fMid, full.subarray(0, midBlock));

  // boundary cut: a clean, shorter file
  const vBoundary = store.verify(fBoundary);
  assert.equal(vBoundary.ok, true);
  assert.equal(vBoundary.truncated, false);
  assert.equal(vBoundary.blocks, 4);

  // mid-block cut: same 4 blocks recovered, but the torn tail is reported
  const vMid = store.verify(fMid);
  assert.equal(vMid.ok, false);
  assert.equal(vMid.truncated, true);
  assert.equal(vMid.blocks, 4);
  assert.equal(vMid.errors[0].code, 'ERR_FORMAT');
  assert.match(vMid.errors[0].message, /truncated/);

  // both recover the identical prefix of records
  const dBoundary = store.decode(fBoundary);
  const dMid = store.decode(fMid);
  assert.deepEqual(
    dMid.records.map((r) => r.payload.toString()),
    dBoundary.records.map((r) => r.payload.toString()),
  );
  assert.equal(dMid.truncated, true);
  assert.equal(dBoundary.truncated, false);

  // recovery is deterministic: repeated runs give identical results
  assert.deepEqual(store.decode(fMid), store.decode(fMid));
  assert.deepEqual(store.verify(fMid), store.verify(fMid));
});

// ---------------------------------------------------------------------------
// Acceptance 4: brute-force replay of the whole history matches the final view
// ---------------------------------------------------------------------------

// Independent reference: recompute the visible view from scan output only,
// walking correction chains by hand (O(n^2) brute force).
function referenceView(scannedBlocks) {
  const valid = scannedBlocks.filter((b) => b.crcOk);
  const revoked = new Set(valid.filter((b) => b.type === 'UNDO').map((b) => b.targetId));
  const byId = new Map(valid.map((b) => [b.id, b]));
  function rootOf(b) {
    let cur = b;
    const seen = new Set();
    while (cur.type !== 'DATA') {
      if (seen.has(cur.id)) return undefined;
      seen.add(cur.id);
      cur = byId.get(cur.targetId);
      if (!cur) return undefined;
    }
    return cur.id;
  }
  const visible = new Map(); // rootId -> blockId
  for (const b of valid) {
    if (b.type === 'DATA') visible.set(b.id, b.id);
    else if (b.type === 'CORRECT' && !revoked.has(b.id)) {
      const r = rootOf(b);
      if (r !== undefined) visible.set(r, b.id);
    }
  }
  return visible;
}

test('acceptance 4: random history, brute-force replay matches final view', () => {
  const rng = mulberry32(0xC0FFEE);
  const f = tmpFile('acc4.wx');
  const model = { blocks: [], revoked: new Set() };
  let conflicts = 0;
  let undos = 0;

  for (let step = 0; step < 200; step++) {
    const r = rng();
    const correctables = model.blocks.filter((b) => b.type !== 'UNDO');
    if (correctables.length === 0 || r < 0.5) {
      const payload = `obs-${step}-${Math.floor(rng() * 1e6)}`;
      const { id } = store.append(f, payload, { timestamp: (step + 1) * 100 });
      model.blocks.push({ id, type: 'DATA', payload, timestamp: (step + 1) * 100 });
    } else if (r < 0.8) {
      const target = correctables[Math.floor(rng() * correctables.length)];
      const payload = `fix-${step}-${Math.floor(rng() * 1e6)}`;
      const { id } = store.correct(f, target.id, payload);
      model.blocks.push({ id, type: 'CORRECT', targetId: target.id, payload, timestamp: target.timestamp });
    } else {
      const corrections = model.blocks.filter((b) => b.type === 'CORRECT');
      if (corrections.length === 0) continue;
      const cand = corrections[Math.floor(rng() * corrections.length)];
      const activeDeps = model.blocks.filter(
        (b) => b.type === 'CORRECT' && b.targetId === cand.id && !model.revoked.has(b.id),
      );
      if (model.revoked.has(cand.id)) {
        const res = store.undo(f, cand.id);
        assert.equal(res.undone, false);
      } else if (activeDeps.length > 0) {
        conflicts++;
        assert.throws(() => store.undo(f, cand.id), (e) => e.code === 'ERR_CONFLICT');
      } else {
        undos++;
        const res = store.undo(f, cand.id);
        assert.equal(res.undone, true);
        model.revoked.add(cand.id);
      }
    }
  }
  assert.ok(conflicts > 0, 'expected the random history to hit at least one ERR_CONFLICT');
  assert.ok(undos > 0, 'expected the random history to contain successful undos');

  // brute-force replay of the whole history vs the library's final view
  const scanned = store.scan(f).blocks;
  const expected = referenceView(scanned);
  const actual = store.decode(f).records;

  assert.equal(actual.length, expected.size);
  const payloadById = new Map(model.blocks.map((b) => [b.id, b.payload]));
  for (const rec of actual) {
    assert.ok(expected.has(rec.rootId), `unexpected visible root ${rec.rootId}`);
    assert.equal(rec.blockId, expected.get(rec.rootId), `root ${rec.rootId} visible version mismatch`);
    assert.equal(rec.payload.toString(), payloadById.get(rec.blockId));
  }

  // every record is also decodable through its own exact time window
  for (const rec of actual) {
    const one = store.decode(f, { start: rec.timestamp, end: rec.timestamp });
    assert.ok(one.records.some((r) => r.rootId === rec.rootId && r.blockId === rec.blockId));
  }
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------
// Runs the CLI in-process (same code path as `node cli.js ...`), because the
// offline sandbox forbids spawning child processes from within node:test.
function runCli(args) {
  return cli.run(args);
}

test('cli: verify/append/correct/undo/decode happy path and error JSON', () => {
  const f = tmpFile('cli.wx');

  let r = runCli(['append', f, '--payload', 'temp=21.3', '--ts', '1000']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['append', f, '--payload', 'hum=55', '--ts', '2000']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['correct', f, '0', '--payload', 'temp=20.9']);
  assert.equal(r.status, 0, r.stderr);

  r = runCli(['verify', f]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.blocks, 3);

  r = runCli(['decode', f, '--start', '500', '--end', '1500']);
  assert.equal(r.status, 0, r.stderr);
  const dec = JSON.parse(r.stdout);
  assert.deepEqual(dec.records.map((x) => x.payload), ['temp=20.9']);

  // undo the correction (block id 2) through the CLI
  r = runCli(['undo', f, '2']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['decode', f, '--start', '500', '--end', '1500']);
  assert.deepEqual(JSON.parse(r.stdout).records.map((x) => x.payload), ['temp=21.3']);

  // error path: undoing a non-existent correction -> stderr JSON + non-zero exit
  r = runCli(['undo', f, '99']);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'ERR_RANGE');
  assert.equal(r.status, 5);

  // error path: invalid decode window
  r = runCli(['decode', f, '--start', '9', '--end', '1']);
  assert.equal(r.status, 5);
  assert.equal(JSON.parse(r.stderr).error.code, 'ERR_RANGE');
});

test('cli: ERR_CONFLICT exit code and stderr JSON', () => {
  const f = tmpFile('cli-conflict.wx');
  assert.equal(runCli(['append', f, '--payload', 'a', '--ts', '1']).status, 0);
  assert.equal(runCli(['correct', f, '0', '--payload', 'b']).status, 0); // block 1
  assert.equal(runCli(['correct', f, '1', '--payload', 'c']).status, 0); // block 2 depends on 1
  const r = runCli(['undo', f, '1']);
  assert.equal(r.status, 6);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'ERR_CONFLICT');
  assert.deepEqual(err.error.details.dependents, [2]);
});

test('cli: verify warns on CRC damage but passes; fails with ERR_CHAIN on header tamper', () => {
  const f = tmpFile('cli-chain.wx');
  store.append(f, 'aaaa', { timestamp: 1 });
  store.append(f, 'bbbb', { timestamp: 2 });

  // payload tamper: CRC warning, chain intact, verify still passes
  let buf = fs.readFileSync(f);
  const b0 = store.scan(f).blocks[0];
  buf[b0.offset + fmt.HEADER_LEN] ^= 0x01;
  fs.writeFileSync(f, buf);
  let r = runCli(['verify', f]);
  assert.equal(r.status, 0);
  let report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.code === 'ERR_CRC' && w.id === 0));

  // header tamper with repaired CRC: chain broken, verify fails with ERR_CHAIN
  buf = fs.readFileSync(f);
  buf.writeBigInt64LE(999n, b0.offset + 18); // timestamp in the header
  const crc = crc32c(buf.subarray(b0.offset, b0.offset + fmt.HEADER_LEN + b0.payloadLength));
  buf.writeUInt32LE(crc, b0.offset + fmt.HEADER_LEN + b0.payloadLength);
  fs.writeFileSync(f, buf);
  r = runCli(['verify', f]);
  assert.equal(r.status, 4);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'ERR_CHAIN');
  report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'ERR_CHAIN' && e.id === 1));
});
