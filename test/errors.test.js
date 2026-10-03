import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Decoder } from '../src/decoder.js';
import { crc32 } from '../src/crc32.js';
import { CncError, E } from '../src/errors.js';
import { encodePackage, readIndex } from '../src/package.js';
import { CLI, DEMO_PROGRAM, runCli } from '../support/helpers.mjs';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function record(seq, payload) {
  return { seq, payload, crc: crc32(payload) };
}

test('duplicate retransmitted blocks are deduplicated idempotently', () => {
  const dec = new Decoder({ totalBlocks: 2 });
  const r0 = record(0, 'G1 X0 Y0');
  const r1 = record(1, 'M30');
  assert.equal(dec.ingest(r0).duplicate, false);
  const dup = dec.ingest(r0);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.ack, 1);
  assert.equal(dec.ingest(r1).duplicate, false);
  assert.equal(dec.ingest(r1).duplicate, true);
  assert.equal(dec.ack, 2);
  dec.run();
  assert.equal(dec.events.length, 1);
  assert.throws(() => dec.ingest(record(0, 'G1 X9 Y9')), (err) => err.code === E.DUP);
});

test('corrupt block payload is rejected with E_CRC', () => {
  const dec = new Decoder({ totalBlocks: 1 });
  assert.throws(
    () => dec.ingest({ seq: 0, payload: 'G1 X0 Y0', crc: 0xdeadbeef }),
    (err) => err.code === E.CRC,
  );
});

test('cli verify and decode report E_CRC (exit 10) on corrupted package', () => {
  const dir = tmpdir('cnc-crc-');
  const prog = path.join(dir, 'demo.nc');
  const base = path.join(dir, 'demo');
  fs.writeFileSync(prog, DEMO_PROGRAM);
  assert.equal(runCli(['encode', prog, '-o', base, '--block-lines', '3']).code, 0);
  const index = readIndex(base);
  const fd = fs.openSync(`${base}.blk`, 'r+');
  const pos = index.blocks[1].offset + 16; // inside block 1 payload
  const orig = Buffer.alloc(1);
  fs.readSync(fd, orig, 0, 1, pos);
  fs.writeSync(fd, Buffer.from([orig[0] ^ 0xff]), 0, 1, pos);
  fs.closeSync(fd);

  const v = runCli(['verify', base]);
  assert.equal(v.code, 10);
  assert.match(v.stderr, /E_CRC/);
  const d = runCli(['decode', base]);
  assert.equal(d.code, 10);
  assert.match(d.stderr, /E_CRC/);
});

test('nesting beyond max-depth fails with E_DEPTH (exit 11)', () => {
  const dir = tmpdir('cnc-depth-');
  const prog = path.join(dir, 'rec.nc');
  const base = path.join(dir, 'rec');
  fs.writeFileSync(prog, 'M98 Ploop\nM30\nOloop\nG1 X1 Y1\nM98 Ploop\nM99\n');
  assert.equal(runCli(['encode', prog, '-o', base, '--block-lines', '2']).code, 0);
  const res = runCli(['decode', base, '--max-depth', '3']);
  assert.equal(res.code, 11);
  assert.match(res.stderr, /E_DEPTH/);
});

test('missing subroutine fails with E_TARGET (exit 12)', () => {
  const dir = tmpdir('cnc-target-');
  const prog = path.join(dir, 'bad.nc');
  const base = path.join(dir, 'bad');
  fs.writeFileSync(prog, 'M98 Pnope\nM30\n');
  assert.equal(runCli(['encode', prog, '-o', base]).code, 0);
  const res = runCli(['decode', base]);
  assert.equal(res.code, 12);
  assert.match(res.stderr, /E_TARGET/);
});

test('missing goto label fails with E_TARGET (exit 12)', () => {
  const dir = tmpdir('cnc-target2-');
  const prog = path.join(dir, 'bad.nc');
  const base = path.join(dir, 'bad');
  fs.writeFileSync(prog, 'GOTO 99\nM30\n');
  assert.equal(runCli(['encode', prog, '-o', base]).code, 0);
  const res = runCli(['decode', base]);
  assert.equal(res.code, 12);
  assert.match(res.stderr, /E_TARGET/);
});
