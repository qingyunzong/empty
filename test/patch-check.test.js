'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEvents, tmpdir, writeLog, writeJson, runCli } = require('./helpers');
const { parseLog, computeHash, GENESIS, serializeLog } = require('../src/chain');

function setup() {
  const dir = tmpdir();
  const oldEvents = makeEvents(10);
  const oldLog = writeLog(dir, 'old.jsonl', oldEvents);
  const fix = writeJson(dir, 'fix.json', {
    patchOps: [
      { op: 'replaceBody', seq: 3, fields: { amount: 999, audited: true } },
      { op: 'void', seq: 5, reason: 'duplicate settlement' },
    ],
  });
  const out = path.join(dir, 'new.jsonl');
  const cert = path.join(dir, 'cert.json');
  return { dir, oldEvents, oldLog, fix, out, cert };
}

test('patch: replaceBody + void, then verify and check pass', async () => {
  const { oldEvents, oldLog, fix, out, cert } = setup();
  const res = await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /changedSeqs=\[3,5\]/);

  const vres = await runCli(['verify', out]);
  assert.equal(vres.status, 0, vres.stderr);

  const cres = await runCli(['check', oldLog, out, cert]);
  assert.equal(cres.status, 0, cres.stderr);
  assert.match(cres.stdout, /changedSeqs=\[3,5\]/);

  const certObj = JSON.parse(fs.readFileSync(cert, 'utf8'));
  assert.deepEqual(certObj.changedSeqs, [3, 5]);
  assert.deepEqual(certObj.unchangedRanges, [[1, 2], [4, 4], [6, 10]]);
  assert.equal(certObj.oldRoot, oldEvents[9].hash);
  assert.equal(certObj.changes.length, 2);
  assert.equal(certObj.changes[0].before, oldEvents[2].hash);
  assert.equal(certObj.changes[1].before, oldEvents[4].hash);

  const newEvents = parseLog(fs.readFileSync(out, 'utf8'));
  // seq order and values untouched
  assert.deepEqual(newEvents.map((e) => e.seq), oldEvents.map((e) => e.seq));
  // replaceBody merged fields
  assert.equal(newEvents[2].body.amount, 999);
  assert.equal(newEvents[2].body.audited, true);
  assert.equal(newEvents[2].body.currency, 'CNY');
  // void kept a tombstone, event not deleted
  assert.equal(newEvents[4].body.tombstone, true);
  assert.equal(newEvents[4].body.reason, 'duplicate settlement');
  assert.equal(newEvents[4].body.voidedHash, oldEvents[4].hash);
  assert.equal(newEvents.length, 10);
});

test('patch: broken-chain input is rejected with exit 9 and writes nothing', async () => {
  const { dir, oldEvents, fix, out, cert } = setup();
  oldEvents[6].hash = '0'.repeat(64);
  const badLog = writeLog(dir, 'bad.jsonl', oldEvents);
  const res = await runCli(['patch', badLog, fix, '--out', out, '--cert', cert]);
  assert.equal(res.status, 9);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.existsSync(cert));
  assert.ok(!fs.existsSync(out + '.tmp'));
});

test('patch: fix.json attempting prevHash modification exits 10', async () => {
  const { dir, oldLog, out, cert } = setup();
  const fix = writeJson(dir, 'evil.json', {
    patchOps: [{ op: 'replaceBody', seq: 2, fields: { x: 1 }, prevHash: 'a'.repeat(64) }],
  });
  const res = await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert]);
  assert.equal(res.status, 10);
  assert.match(res.stderr, /prevHash/);
});

test('patch: unknown op and duplicate seq are rejected with exit 1', async () => {
  const { dir, oldLog, out, cert } = setup();
  const fix1 = writeJson(dir, 'f1.json', { patchOps: [{ op: 'delete', seq: 2 }] });
  assert.equal((await runCli(['patch', oldLog, fix1, '--out', out, '--cert', cert])).status, 1);
  const fix2 = writeJson(dir, 'f2.json', {
    patchOps: [
      { op: 'void', seq: 2, reason: 'a' },
      { op: 'void', seq: 2, reason: 'b' },
    ],
  });
  assert.equal((await runCli(['patch', oldLog, fix2, '--out', out, '--cert', cert])).status, 1);
});

test('check: tampered cert change record exits 11 and locates first seq', async () => {
  const { oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  const certObj = JSON.parse(fs.readFileSync(cert, 'utf8'));
  certObj.changes[1].after = 'b'.repeat(64); // tamper seq 5 record
  certObj.changes[0].after = 'c'.repeat(64); // and seq 3 record
  fs.writeFileSync(cert, JSON.stringify(certObj, null, 2));
  const res = await runCli(['check', oldLog, out, cert]);
  assert.equal(res.status, 11);
  assert.match(res.stderr, /seq 3/); // first offending seq reported
});

test('check: tampered cert unchangedRanges exits 11', async () => {
  const { oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  const certObj = JSON.parse(fs.readFileSync(cert, 'utf8'));
  certObj.unchangedRanges = [[1, 10]];
  fs.writeFileSync(cert, JSON.stringify(certObj, null, 2));
  const res = await runCli(['check', oldLog, out, cert]);
  assert.equal(res.status, 11);
  assert.match(res.stderr, /unchangedRanges/);
});

test('check: tampered cert newRoot exits 11', async () => {
  const { oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  const certObj = JSON.parse(fs.readFileSync(cert, 'utf8'));
  certObj.newRoot = 'd'.repeat(64);
  fs.writeFileSync(cert, JSON.stringify(certObj, null, 2));
  const res = await runCli(['check', oldLog, out, cert]);
  assert.equal(res.status, 11);
  assert.match(res.stderr, /newRoot/);
});

test('check: silently modified unchanged event exits 11 locating first seq', async () => {
  const { oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  // Attacker modifies body of seq 7 (not in changedSeqs) and re-computes the
  // chain so the new log still passes verify; check must catch it via cert.
  const events = parseLog(fs.readFileSync(out, 'utf8'));
  events[6].body.amount = 1;
  let prev = GENESIS;
  for (const ev of events) {
    ev.prevHash = prev;
    ev.hash = computeHash(prev, ev.body);
    prev = ev.hash;
  }
  fs.writeFileSync(out, serializeLog(events));
  assert.equal((await runCli(['verify', out])).status, 0); // chain itself is valid
  const res = await runCli(['check', oldLog, out, cert]);
  assert.equal(res.status, 11);
  assert.match(res.stderr, /seq 7/);
});

test('check: new log with extra events (seq set changed) exits 10', async () => {
  const { dir, oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  const extended = writeLog(dir, 'extended.jsonl', makeEvents(11));
  assert.equal((await runCli(['verify', extended])).status, 0);
  const res = await runCli(['check', oldLog, extended, cert]);
  assert.equal(res.status, 10);
  assert.match(res.stderr, /event count differs/);
});

test('check: broken-chain new log exits 9 (not 11)', async () => {
  const { oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  const events = parseLog(fs.readFileSync(out, 'utf8'));
  events[8].hash = 'e'.repeat(64);
  fs.writeFileSync(out, serializeLog(events));
  const res = await runCli(['check', oldLog, out, cert]);
  assert.equal(res.status, 9);
});
