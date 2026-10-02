'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeFrame } = require('../src/frame');
const { EXIT } = require('../src/errors');
const { ev, scenario, scenarioEvents } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'packline-'));
}

function writeHex(dir, frames) {
  const file = path.join(dir, 'frames.hex');
  fs.writeFileSync(file, Buffer.concat(frames).toString('hex') + '\n');
  return file;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('CLI exports a traceability package (exit 0)', () => {
  const dir = tmpdir();
  const events = scenarioEvents();
  // Out-of-order delivery plus a retransmitted duplicate.
  const order = [events[2], events[0], events[1], events[3], events[4], events[2], events[5]];
  const hexFile = writeHex(dir, order.map((e) => encodeFrame(e)));
  const pkgFile = path.join(dir, 'pkg.json');

  const res = runCli([hexFile, '--export', pkgFile]);
  assert.equal(res.status, EXIT.OK, res.stderr);

  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  assert.equal(pkg.format, 'packline-trace/1');
  assert.match(pkg.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(pkg.eventCount, 6);
  assert.equal(pkg.validCount, 4);
  assert.equal(pkg.items['ITEM-A'].status, 'REWORK');
  assert.equal(pkg.items['ITEM-B'].status, 'SCRAPPED');
  assert.equal(pkg.items['ITEM-B'].qty, 4);
  assert.equal(pkg.supersededChains.length, 2);
  assert.equal(pkg.validEvents.length, 4);
});

test('CLI exits 9 on unknown ref', () => {
  const dir = tmpdir();
  const ghost = ev({ batch: 'B1', item: 'X', seq: 0, lamport: 0, kind: 'CORRECT', ref: '00'.repeat(32), qty: 1, reason: 'miscount' });
  const hexFile = writeHex(dir, [encodeFrame(ghost)]);
  const res = runCli([hexFile, '--export', path.join(dir, 'pkg.json')]);
  assert.equal(res.status, EXIT.REF_UNKNOWN, res.stderr);
});

test('CLI exits 10 on SCRAP terminal violation', () => {
  const dir = tmpdir();
  const { bPack, bScrap } = scenario();
  const bad = ev({ batch: 'B1', item: 'ITEM-B', seq: 9, lamport: 6, kind: 'CORRECT', ref: bPack.id, qty: 7, reason: 'recount' });
  const hexFile = writeHex(dir, [bPack, bScrap, bad].map((e) => encodeFrame(e)));
  const res = runCli([hexFile, '--export', path.join(dir, 'pkg.json')]);
  assert.equal(res.status, EXIT.TERMINAL, res.stderr);
});

test('CLI exits 2 on corrupted frame', () => {
  const dir = tmpdir();
  const frame = Buffer.from(encodeFrame(ev({ batch: 'B', item: 'X', seq: 0, lamport: 0, kind: 'PACK', qty: 1 })));
  frame[10] ^= 0x01; // flip a payload byte: crc no longer matches
  const hexFile = writeHex(dir, [frame]);
  const res = runCli([hexFile, '--export', path.join(dir, 'pkg.json')]);
  assert.equal(res.status, EXIT.FRAME, res.stderr);
});

test('CLI exits 2 on invalid hex input', () => {
  const dir = tmpdir();
  const hexFile = path.join(dir, 'frames.hex');
  fs.writeFileSync(hexFile, 'zzzz\n');
  const res = runCli([hexFile]);
  assert.equal(res.status, EXIT.FRAME, res.stderr);
});
