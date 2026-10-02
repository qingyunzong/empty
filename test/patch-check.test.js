import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLog, makeDir, writeJsonl, runCli } from './helpers.js';
import { parseLog } from '../src/log.js';
import { hashEvent } from '../src/canonical.js';

function setup() {
  const dir = makeDir();
  const old = join(dir, 'old.jsonl');
  const fix = join(dir, 'fix.json');
  const out = join(dir, 'new.jsonl');
  const cert = join(dir, 'cert.json');
  writeJsonl(old, makeLog(6));
  writeFileSync(fix, JSON.stringify({
    patchOps: [
      { op: 'replaceBody', seq: 2, fields: { amount: 999 } },
      { op: 'void', seq: 5, reason: 'duplicate settlement' },
    ],
  }));
  return { dir, old, fix, out, cert };
}

test('patch applies ops, keeps chain valid, check passes', () => {
  const { old, fix, out, cert } = setup();
  const p = runCli(['patch', old, fix, '--out', out, '--cert', cert]);
  assert.equal(p.code, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout).changedSeqs, [2, 5]);

  const v = runCli(['verify', out]);
  assert.equal(v.code, 0, v.stderr);

  const events = parseLog(readFileSync(out, 'utf8'));
  assert.equal(events[1].body.amount, 999); // replaceBody merged
  assert.equal(events[1].body.id, 'evt-2'); // untouched fields kept
  assert.deepEqual(events[4].body, { voided: true, reason: 'duplicate settlement' }); // tombstone
  assert.equal(events[4].seq, 5); // tombstone keeps its slot

  const c = runCli(['check', old, out, cert]);
  assert.equal(c.code, 0, c.stderr);
});

test('patch rejects broken-chain input with exit 9', () => {
  const { old, fix, out, cert } = setup();
  const events = parseLog(readFileSync(old, 'utf8'));
  events[1].hash = '0'.repeat(64);
  writeJsonl(old, events);
  const p = runCli(['patch', old, fix, '--out', out, '--cert', cert]);
  assert.equal(p.code, 9);
});

test('patch rejects unknown ops and out-of-range seq with exit 2', () => {
  const { old, fix, out, cert } = setup();
  writeFileSync(fix, JSON.stringify({ patchOps: [{ op: 'delete', seq: 1 }] }));
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 2);
  writeFileSync(fix, JSON.stringify({ patchOps: [{ op: 'void', seq: 99, reason: 'x' }] }));
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 2);
});

test('check detects tampered certificate with exit 11 and first seq', () => {
  const { old, fix, out, cert } = setup();
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 0);
  const c = JSON.parse(readFileSync(cert, 'utf8'));
  c.changes[1].afterHash = '0'.repeat(64); // tamper seq 5 entry
  writeFileSync(cert, JSON.stringify(c));
  const r = runCli(['check', old, out, cert]);
  assert.equal(r.code, 11, r.stderr);
  assert.match(r.stderr, /seq 5/);
});

test('check detects forged log+cert hiding an uncertified change', () => {
  const { old, fix, out, cert } = setup();
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 0);
  // Forgery attempt: alter certified-unchanged seq 1, recompute the whole chain,
  // and update cert.newRoot so the log still verifies.
  const events = parseLog(readFileSync(out, 'utf8'));
  events[0].body = { ...events[0].body, amount: 1 };
  for (let i = 0; i < events.length; i++) {
    events[i].prevHash = i === 0 ? '' : events[i - 1].hash;
    events[i].hash = hashEvent(events[i].prevHash, events[i].body);
  }
  writeJsonl(out, events);
  const c = JSON.parse(readFileSync(cert, 'utf8'));
  c.newRoot = events[events.length - 1].hash;
  writeFileSync(cert, JSON.stringify(c));
  const r = runCli(['check', old, out, cert]);
  assert.equal(r.code, 11);
  assert.match(r.stderr, /seq 1/);
});

test('check reports first failing seq when several are wrong', () => {
  const { old, fix, out, cert } = setup();
  writeFileSync(fix, JSON.stringify({ patchOps: [
    { op: 'replaceBody', seq: 2, fields: { amount: 1 } },
    { op: 'replaceBody', seq: 4, fields: { amount: 1 } },
  ] }));
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 0);
  const c = JSON.parse(readFileSync(cert, 'utf8'));
  c.changes[0].beforeHash = '0'.repeat(64); // seq 2
  c.changes[1].beforeHash = '0'.repeat(64); // seq 4
  writeFileSync(cert, JSON.stringify(c));
  const r = runCli(['check', old, out, cert]);
  assert.equal(r.code, 11);
  assert.match(r.stderr, /first seq: 2/);
});

test('check rejects unauthorized seq change with exit 10', () => {
  const { old, fix, out, cert } = setup();
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 0);
  const events = parseLog(readFileSync(out, 'utf8'));
  events[3].seq = 42;
  writeJsonl(out, events);
  const r = runCli(['check', old, out, cert]);
  assert.equal(r.code, 10, r.stderr);
});

test('check rejects tampered newRoot with exit 11', () => {
  const { old, fix, out, cert } = setup();
  assert.equal(runCli(['patch', old, fix, '--out', out, '--cert', cert]).code, 0);
  const c = JSON.parse(readFileSync(cert, 'utf8'));
  c.newRoot = '0'.repeat(64);
  writeFileSync(cert, JSON.stringify(c));
  assert.equal(runCli(['check', old, out, cert]).code, 11);
});
