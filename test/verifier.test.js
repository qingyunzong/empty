import test from 'node:test';
import assert from 'node:assert/strict';
import {
  check,
  referenceLinearizable,
  findMinimalPrefix,
  findMinimalCertificate,
  projectItems,
  VERDICT,
} from '../src/verifier.js';

test('linearizable: extend -> cyl_done -> retract -> cyl_done', () => {
  const h = {
    ops: [
      { id: 'o1', cmd: 'extend', start: 1, end: 2, args: { expect: 'ok' } },
      { id: 'o2', cmd: 'retract', start: 5, end: 6, args: { expect: 'ok' } },
    ],
    events: [
      { id: 'e1', ts: 3, src: 'cyl', kind: 'cyl_done', args: {} },
      { id: 'e2', ts: 7, src: 'cyl', kind: 'cyl_done', args: {} },
    ],
    seed: 1,
  };
  assert.equal(check(h).verdict, VERDICT.LINEARIZABLE);
  assert.equal(referenceLinearizable(h), true);
});

test('ack confirmation must match the command result', () => {
  const base = {
    ops: [{ id: 'o1', cmd: 'extend', start: 1, end: 4, args: { expect: 'ok' } }],
    seed: 2,
  };
  const good = { ...base, events: [{ id: 'a1', ts: 5, src: 'plc', kind: 'ack', args: { op: 'o1', ok: 'ok' } }] };
  const bad = { ...base, events: [{ id: 'a1', ts: 5, src: 'plc', kind: 'ack', args: { op: 'o1', ok: 'fail' } }] };
  assert.equal(check(good).verdict, VERDICT.LINEARIZABLE);
  assert.equal(check(bad).verdict, VERDICT.VIOLATION);
});

test('acceptance 3: non-linearizable history yields minimal prefix and 1-minimal certificate', () => {
  // estop at ts=5 lands before the extend window [6,10]: the extend must
  // linearize while the e-stop is latched, so its observed 'ok' is impossible.
  const h = {
    ops: [
      { id: 'o1', cmd: 'extend', start: 6, end: 10, args: { expect: 'ok' } },
      { id: 'o2', cmd: 'reset', start: 1, end: 2, args: { expect: 'fail' } },
    ],
    events: [
      { id: 'e1', ts: 5, src: 'plc', kind: 'estop', args: {} },
      { id: 'e3', ts: 0, src: 'photo', kind: 'photo', args: {} },
      { id: 'e4', ts: 3, src: 'plc', kind: 'ack', args: { op: 'o2', ok: 'fail' } },
    ],
    seed: 42,
  };
  assert.equal(check(h).verdict, VERDICT.VIOLATION);
  assert.equal(referenceLinearizable(h), false);

  // Minimal violating prefix over the canonical interleaving.
  const prefix = findMinimalPrefix(h);
  assert.ok(prefix, 'expected a minimal prefix');
  assert.equal(check(prefix.history).verdict, VERDICT.VIOLATION);
  const shorter = projectItems(prefix.items.slice(0, -1), h.seed);
  assert.notEqual(check(shorter).verdict, VERDICT.VIOLATION, 'prefix must be minimal');

  // Minimal certificate: still a violation, and deleting ANY single item
  // (event or op) makes it pass.
  const cert = findMinimalCertificate(h);
  assert.ok(cert, 'expected a certificate');
  assert.equal(check(cert.history).verdict, VERDICT.VIOLATION);
  assert.equal(cert.items.length, 2);
  assert.ok(cert.items.some((i) => i.type === 'event' && i.ref.id === 'e1'));
  assert.ok(cert.items.some((i) => i.type === 'op' && i.ref.id === 'o1'));
  for (const item of cert.items) {
    const rest = cert.items.filter((x) => x !== item);
    assert.equal(
      check(projectItems(rest, h.seed)).verdict,
      VERDICT.LINEARIZABLE,
      `removing ${item.key} must make the certificate pass`,
    );
  }
});

test('acceptance 4: op without end stays UNKNOWN (never VIOLATION)', () => {
  const pending = {
    ops: [{ id: 'o1', cmd: 'extend', start: 1, args: { expect: 'ok' } }],
    events: [],
    seed: 3,
  };
  const r = check(pending);
  assert.equal(r.verdict, VERDICT.UNKNOWN);
  assert.equal(r.reason, 'pending-op');
  assert.notEqual(r.verdict, VERDICT.VIOLATION);

  // Even a history that violates among completed ops is UNKNOWN while an op
  // is still pending.
  const mixed = {
    ops: [
      { id: 'o1', cmd: 'extend', start: 6, end: 10, args: { expect: 'ok' } },
      { id: 'o2', cmd: 'retract', start: 1, args: { expect: 'ok' } },
    ],
    events: [{ id: 'e1', ts: 5, src: 'plc', kind: 'estop', args: {} }],
    seed: 4,
  };
  assert.equal(check(mixed).verdict, VERDICT.UNKNOWN);
});

test('budget exhaustion yields UNKNOWN, not VIOLATION', () => {
  const h = {
    ops: [{ id: 'o1', cmd: 'extend', start: 1, end: 2, args: { expect: 'ok' } }],
    events: [{ id: 'e1', ts: 3, src: 'cyl', kind: 'cyl_done', args: {} }],
    seed: 5,
  };
  const r = check(h, { maxNodes: 0 });
  assert.equal(r.verdict, VERDICT.UNKNOWN);
  assert.equal(r.reason, 'budget-exceeded');
});
