import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const CFG = { setup: 10, lock: 30, maxRate: 1000 };
const mkStore = () => new Store(mkdtempSync(join(tmpdir(), 'satsched-')));
const pass = (id, start, end, extra = {}) => ({
  pass: { id, task: `T-${id}`, start, end, elevation: 10, rate: 100, priority: 0, onboard: 1e6 },
  task: {},
  ...extra,
});

test('hash chain verifies and replay is deterministic', () => {
  const s = mkStore();
  s.append('init', CFG);
  s.append('pass', pass('P1', 0, 100));
  s.append('pass', pass('P2', 200, 300));
  const r = s.verify();
  assert.ok(r.ok);
  assert.equal(r.entries, 3);
  assert.deepStrictEqual(s.state(), s.state(), 'replay is deterministic');
});

test('acceptance 4: verify rejects a half-written tail and recovers', () => {
  const s = mkStore();
  s.append('init', CFG);
  s.append('pass', pass('P1', 0, 100));
  s.append('pass', pass('P2', 200, 300));
  const goodLines = readFileSync(s.journal, 'utf8').split('\n').filter(Boolean).length;
  // Simulate a crashed write: partial JSON line, no newline.
  appendFileSync(s.journal, '{"seq":4,"op":"pass","payload":{"pass":{"id":"P3"');
  const r = s.verify();
  assert.equal(r.ok, false);
  assert.equal(r.good, goodLines);
  const rec = s.recover();
  assert.equal(rec.removed, 1);
  const r2 = s.verify();
  assert.ok(r2.ok);
  assert.equal(r2.entries, goodLines);
  assert.deepEqual(s.state().passes.map((p) => p.id), ['P1', 'P2']);
});

test('verify rejects tampered entries', () => {
  const s = mkStore();
  s.append('init', CFG);
  s.append('pass', pass('P1', 0, 100));
  const lines = s.rawLines();
  const tampered = JSON.parse(lines[1]);
  tampered.payload.pass.rate = 999;
  lines[1] = JSON.stringify(tampered);
  writeFileSync(s.journal, lines.map((l) => l + '\n').join(''));
  const r = s.verify();
  assert.equal(r.ok, false);
  assert.equal(r.good, 1);
});

test('undo: multi-level and to any pass boundary, replay stays consistent', () => {
  const s = mkStore();
  s.append('init', CFG);
  s.append('pass', pass('P1', 0, 100));
  s.append('pass', pass('P2', 200, 300));
  s.append('pass', pass('P3', 400, 500));
  s.undo({ steps: 2 });
  assert.deepEqual(s.state().passes.map((p) => p.id), ['P1']);
  s.append('pass', pass('P4', 600, 700));
  s.undo({ toPass: 'P1' });
  assert.deepEqual(s.state().passes.map((p) => p.id), []);
  assert.ok(s.verify().ok, 'chain with undo entries still verifies');
});

test('undo of confirmed bytes is refused (DomainError, exit code 9)', () => {
  const s = mkStore();
  s.append('init', CFG);
  s.append('pass', pass('P1', 0, 50));
  s.append('pass', pass('P2', 50, 100));
  // Correction at t=60 confirms P1's segment [0,50) as on-the-ground bytes.
  s.append('correct', { pass: 'P2', start: 50, end: 100, at: 60, pending: false });
  assert.throws(() => s.undo({ steps: 1 }), (e) => e.code === 9 && /confirmed/.test(e.message));
  assert.ok(s.verify().ok, 'journal untouched after refused undo');
});

test('undo of a pending correction is allowed', () => {
  const s = mkStore();
  s.append('init', CFG);
  s.append('pass', pass('P1', 0, 100));
  s.append('correct', { pass: 'P1', start: 0, end: 40, at: 0, pending: true });
  s.undo({ steps: 1 });
  assert.equal(s.state().passes[0].corrections.length, 0);
  assert.ok(s.verify().ok);
});

test('domain validation: negative elevation and overspeed rate (exit code 9)', () => {
  const s = mkStore();
  s.append('init', CFG);
  assert.throws(
    () => s.append('pass', { pass: { ...pass('PX', 0, 100).pass, elevation: -1 }, task: {} }),
    (e) => e.code === 9 && /elevation/.test(e.message)
  );
  assert.throws(
    () => s.append('pass', { pass: { ...pass('PY', 0, 100).pass, rate: 1001 }, task: {} }),
    (e) => e.code === 9 && /link max/.test(e.message)
  );
  assert.ok(s.verify().ok, 'rejected entries never reach the journal');
});
