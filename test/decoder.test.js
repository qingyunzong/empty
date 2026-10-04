import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePrograms } from '../src/codec.js';
import { crc32 } from '../src/crc32.js';
import { Decoder, DecodeError } from '../src/decoder.js';

const MAIN = ['N1 G21 G90', 'M98 Psub', 'GOTO N10', 'G1 X999', 'N10 G1 X1', 'M30'].join('\n');
const SUB = ['N1 G91', 'G1 X5', 'M99'].join('\n');
const SOURCES = [
  { name: 'main', text: MAIN },
  { name: 'sub', text: SUB },
];

// Hand-enumerated execution sequence:
//   main: N1 G21 G90 -> M98 Psub
//     sub: N1 G91 -> G1 X5 -> M99 (return)
//   main: GOTO N10 (skips G1 X999) -> N10 G1 X1 -> M30
const EXPECTED_TRACE = [
  'N1 G21 G90',
  'M98 Psub',
  'N1 G91',
  'G1 X5',
  'M99',
  'GOTO N10',
  'N10 G1 X1',
  'M30',
];

function makePackage(sources = SOURCES, opts = { blockLines: 2 }) {
  const { index, data } = encodePrograms(sources, opts);
  const blocks = [];
  let off = 0;
  while (off < data.length) {
    const seq = data.readUInt32LE(off);
    const len = data.readUInt32LE(off + 4);
    const crc = data.readUInt32LE(off + 8);
    const payload = data.subarray(off + 12, off + 12 + len);
    blocks.push({ seq, crc, payload: Buffer.from(payload) });
    off += 12 + len;
  }
  return { index, blocks };
}

function fullDecode({ index, blocks }, opts) {
  const dec = new Decoder(index, opts);
  for (const b of blocks) dec.addBlock(b.seq, b.crc, b.payload);
  const status = dec.run();
  return { dec, status };
}

test('branch + subroutine trace matches hand-enumerated sequence', () => {
  const pkg = makePackage();
  const { status } = fullDecode(pkg);
  assert.equal(status.done, true);
  assert.deepEqual(
    status.trace.map((t) => t.text),
    EXPECTED_TRACE,
  );
  assert.equal(status.nextSeq, null);
  assert.equal(status.confirmed, 5);
});

test('resume from any sequence number yields identical execution', () => {
  const pkg = makePackage();
  const full = fullDecode(pkg);
  const fullTrace = full.status.trace.map((t) => t.text);
  for (let k = 0; k <= pkg.blocks.length; k++) {
    const dec = new Decoder(pkg.index, { recordTrace: false });
    for (const b of pkg.blocks.slice(0, k)) dec.addBlock(b.seq, b.crc, b.payload);
    dec.run();
    const replayed = dec.executedCount;
    dec.recordTrace = true;
    for (const b of pkg.blocks.slice(k)) dec.addBlock(b.seq, b.crc, b.payload);
    const status = dec.run();
    assert.equal(status.done, true, `resume from ${k} should finish`);
    assert.equal(dec.executedCount, full.dec.executedCount, `executed count at resume ${k}`);
    assert.deepEqual(
      fullTrace.slice(replayed),
      status.trace.map((t) => t.text),
      `resumed trace from seq ${k} must continue the full trace without re-executing`,
    );
  }
});

test('retransmitted blocks are deduplicated idempotently by sequence number', () => {
  const pkg = makePackage();
  const dec = new Decoder(pkg.index);
  for (const b of pkg.blocks) {
    dec.addBlock(b.seq, b.crc, b.payload);
    const dup = dec.addBlock(b.seq, b.crc, b.payload);
    assert.equal(dup.duplicate, true);
  }
  // duplicate with different payload but same seq is ignored (first wins)
  const alt = Buffer.from('G1 X777');
  const dup = dec.addBlock(0, crc32(alt), alt);
  assert.equal(dup.duplicate, true);
  const status = dec.run();
  assert.deepEqual(
    status.trace.map((t) => t.text),
    EXPECTED_TRACE,
  );
  assert.equal(dec.executedCount, EXPECTED_TRACE.length);
});

test('corrupted block reports E_CRC', () => {
  const pkg = makePackage();
  const dec = new Decoder(pkg.index);
  const bad = Buffer.from(pkg.blocks[2].payload);
  bad[0] ^= 0xff;
  assert.throws(() => dec.addBlock(2, pkg.blocks[2].crc, bad), (err) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'E_CRC');
    return true;
  });
});

test('nesting beyond maxDepth reports E_DEPTH', () => {
  const sources = [
    { name: 'main', text: 'M98 Pa\nM30' },
    { name: 'a', text: 'M98 Pb\nM99' },
    { name: 'b', text: 'G1 X1\nM99' },
  ];
  const pkg = makePackage(sources, { blockLines: 4 });
  const dec = new Decoder(pkg.index, { maxDepth: 1 });
  for (const b of pkg.blocks) dec.addBlock(b.seq, b.crc, b.payload);
  assert.throws(() => dec.run(), (err) => {
    assert.equal(err.code, 'E_DEPTH');
    return true;
  });
  // same program decodes fine with enough depth
  const ok = new Decoder(pkg.index, { maxDepth: 2 });
  for (const b of pkg.blocks) ok.addBlock(b.seq, b.crc, b.payload);
  assert.equal(ok.run().done, true);
});

test('missing subroutine reports E_TARGET', () => {
  const pkg = makePackage([{ name: 'main', text: 'M98 Pghost\nM30' }], { blockLines: 4 });
  const dec = new Decoder(pkg.index);
  for (const b of pkg.blocks) dec.addBlock(b.seq, b.crc, b.payload);
  assert.throws(() => dec.run(), (err) => {
    assert.equal(err.code, 'E_TARGET');
    return true;
  });
});

test('missing jump label reports E_TARGET', () => {
  const pkg = makePackage([{ name: 'main', text: 'GOTO N77\nM30' }], { blockLines: 4 });
  const dec = new Decoder(pkg.index);
  for (const b of pkg.blocks) dec.addBlock(b.seq, b.crc, b.payload);
  assert.throws(() => dec.run(), (err) => {
    assert.equal(err.code, 'E_TARGET');
    return true;
  });
});

test('incremental feed reports confirmed prefix and next needed sequence', () => {
  const pkg = makePackage();
  const dec = new Decoder(pkg.index);
  dec.addBlock(pkg.blocks[0].seq, pkg.blocks[0].crc, pkg.blocks[0].payload);
  dec.addBlock(pkg.blocks[1].seq, pkg.blocks[1].crc, pkg.blocks[1].payload);
  let status = dec.run();
  assert.equal(status.confirmed, 2);
  assert.equal(status.nextSeq, 2);
  assert.equal(status.done, false);
  // out-of-order arrival: confirmed prefix does not advance past the gap
  dec.addBlock(pkg.blocks[4].seq, pkg.blocks[4].crc, pkg.blocks[4].payload);
  status = dec.run();
  assert.equal(status.confirmed, 2);
  assert.equal(status.nextSeq, 2);
  for (const b of pkg.blocks.slice(2, 4)) dec.addBlock(b.seq, b.crc, b.payload);
  status = dec.run();
  assert.equal(status.done, true);
  assert.equal(status.confirmed, 5);
  assert.equal(status.nextSeq, null);
});
