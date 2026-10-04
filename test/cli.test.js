'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeEvent, toHexLines, eventId } = require('./helpers');
const { Ledger } = require('../src/ledger');

const CLI = path.join(__dirname, '..', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'packline-'));
}

function sampleEvents() {
  const pack = makeEvent({ batch: 'B1', item: 'A', seq: 1, lamport: 1, kind: 'PACK', qty: 10 });
  const fix = makeEvent({
    batch: 'B1', item: 'A', seq: 2, lamport: 2, kind: 'CORRECT',
    ref: eventId(pack), qty: 12, reason: 'recount',
  });
  const scrap = makeEvent({ batch: 'B1', item: 'B', seq: 1, lamport: 3, kind: 'SCRAP', qty: 2 });
  return [pack, fix, scrap];
}

test('cli exports a traceability package (exit 0)', () => {
  const dir = tmpdir();
  const hex = path.join(dir, 'frames.hex');
  const pkg = path.join(dir, 'pkg.json');
  // fragmented frames + duplicate retransmissions, out of order
  const lines = toHexLines(sampleEvents(), { maxPayload: 32, duplicates: true }).reverse();
  fs.writeFileSync(hex, lines.join('\n') + '\n');

  const res = runCli([hex, '--export', pkg]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(fs.readFileSync(pkg, 'utf8'));

  assert.equal(out.eventCount, 3);
  assert.equal(out.itemCount, 2);
  assert.equal(out.items['A'].qty, 12); // corrected quantity wins
  assert.equal(out.items['B'].state, 'SCRAPPED');
  assert.equal(out.validEvents.length, 2);
  assert.equal(out.supersededChains.length, 1);
  assert.deepEqual(out.supersededChains[0].chain, [eventId(sampleEvents()[0]), eventId(sampleEvents()[1])]);
  assert.equal(out.supersededEvents.length, 1);
  assert.equal(out.supersededEvents[0].status, 'superseded');
  assert.match(out.contentHash, /^[0-9a-f]{64}$/);

  // exported hash matches an independent in-process recompute
  const ledger = new Ledger();
  for (const e of sampleEvents()) ledger.ingest(e);
  assert.equal(out.contentHash, ledger.recomputeHash());
});

test('cli exits 9 when a CORRECT ref does not exist', () => {
  const dir = tmpdir();
  const hex = path.join(dir, 'frames.hex');
  const orphan = makeEvent({
    batch: 'B1', item: 'A', seq: 2, lamport: 2, kind: 'CORRECT',
    ref: 'B1|A|99|PACK', qty: 1, reason: 'recount',
  });
  fs.writeFileSync(hex, toHexLines([orphan]).join('\n') + '\n');
  const res = runCli([hex, '--export', path.join(dir, 'pkg.json')]);
  assert.equal(res.status, 9, res.stderr);
  assert.match(res.stderr, /unknown event/);
});

test('cli exits 10 on terminal-state violation', () => {
  const dir = tmpdir();
  const hex = path.join(dir, 'frames.hex');
  const scrap = makeEvent({ batch: 'B1', item: 'A', seq: 1, lamport: 1, kind: 'SCRAP', qty: 1 });
  const fix = makeEvent({
    batch: 'B1', item: 'A', seq: 2, lamport: 2, kind: 'CORRECT',
    ref: eventId(scrap), qty: 1, reason: 'recount', // not 'audit'
  });
  fs.writeFileSync(hex, toHexLines([scrap, fix]).join('\n') + '\n');
  const res = runCli([hex, '--export', path.join(dir, 'pkg.json')]);
  assert.equal(res.status, 10, res.stderr);
  assert.match(res.stderr, /terminal SCRAP/);
});

test('cli exits 2 on frame errors', () => {
  const dir = tmpdir();
  const hex = path.join(dir, 'frames.hex');
  fs.writeFileSync(hex, 'zz-not-hex\n');
  assert.equal(runCli([hex, '--export', path.join(dir, 'p.json')]).status, 2);

  fs.writeFileSync(hex, '00ff\n'); // bad magic
  assert.equal(runCli([hex, '--export', path.join(dir, 'p.json')]).status, 2);

  // bad signature
  const e = makeEvent({ batch: 'B1', item: 'A', seq: 1, lamport: 1, kind: 'PACK', qty: 1 });
  e.sig = '0'.repeat(64);
  fs.writeFileSync(hex, toHexLines([e]).join('\n') + '\n');
  assert.equal(runCli([hex, '--export', path.join(dir, 'p.json')]).status, 2);

  // usage error
  assert.equal(runCli([]).status, 2);
});
