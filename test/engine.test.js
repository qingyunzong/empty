import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../src/compile.js';
import { Engine } from '../src/engine.js';

function makeEngine(extra = '') {
  const policy = compileSource(`
    customer C0001;
    note /^[A-Z0-9-]{3,32}$/;
    bucket b { limit 1000; }
    approval L1 { approval L2 { } }
    ${extra}`);
  return new Engine(policy);
}

function run(eng, events) {
  eng.applyAll(events);
  return eng.log;
}

const frz = (id, amount, extra = {}) => ({
  type: 'freeze', id, ts: '2026-10-01T09:00:00Z', customer: 'C0001',
  bucket: 'b', amount, until: '2026-12-31', note: 'REQ-1', scope: ['L1'], ...extra,
});

test('acceptance 2: freeze exactly equal to available succeeds, next one fails without partial deduction', () => {
  const eng = makeEngine();
  const log = run(eng, [frz('F1', 1000), frz('F2', 1, { ts: '2026-10-01T10:00:00Z' })]);
  assert.equal(log[0].ok, true);
  assert.equal(log[1].ok, false);
  assert.equal(log[1].error.code, 'E_CAP');
  const b = eng.buckets.get('b');
  assert.deepEqual([b.available, b.frozen, b.used], [0, 1000, 0]); // no partial deduction
});

test('acceptance 2: expiry takes effect at 00:00 on the until date, batched per business day', () => {
  const eng = makeEngine();
  const log = run(eng, [
    frz('F1', 400),
    { type: 'business_day', id: 'BD1', date: '2026-12-30' },
    { type: 'business_day', id: 'BD2', date: '2026-12-31' },
  ]);
  assert.equal(log[1].info.expired.length, 0); // 2026-12-30: not yet
  assert.deepEqual(log[2].info.expired, [{ id: 'F1', released: 400 }]); // 2026-12-31 00:00 batch
  const b = eng.buckets.get('b');
  assert.deepEqual([b.available, b.frozen, b.used], [1000, 0, 0]);
});

test('acceptance 2: freeze timestamped at expiry 00:00 is E_EXPIRED', () => {
  const eng = makeEngine();
  const log = run(eng, [frz('F1', 100, { ts: '2026-12-31T00:00:00Z', until: '2026-12-31' })]);
  assert.equal(log[0].ok, false);
  assert.equal(log[0].error.code, 'E_EXPIRED');
});

test('acceptance 2: negative unfreeze is rejected (E_CAP)', () => {
  const eng = makeEngine();
  const log = run(eng, [
    frz('F1', 500),
    { type: 'unfreeze', id: 'U1', ts: '2026-10-02T09:00:00Z', customer: 'C0001', bucket: 'b', amount: -5, note: 'REQ-2', freeze_id: 'F1' },
  ]);
  assert.equal(log[1].ok, false);
  assert.equal(log[1].error.code, 'E_CAP');
  assert.equal(eng.buckets.get('b').frozen, 500);
});

test('unfreeze releases only the unused part of a freeze', () => {
  const eng = makeEngine();
  const log = run(eng, [
    frz('F1', 500),
    { type: 'debit', id: 'D1', ts: '2026-10-02T09:00:00Z', customer: 'C0001', bucket: 'b', amount: 200, note: 'REQ-2', freeze_id: 'F1' },
    { type: 'unfreeze', id: 'U1', ts: '2026-10-03T09:00:00Z', customer: 'C0001', bucket: 'b', amount: 301, note: 'REQ-3', freeze_id: 'F1' },
    { type: 'unfreeze', id: 'U2', ts: '2026-10-04T09:00:00Z', customer: 'C0001', bucket: 'b', amount: 300, note: 'REQ-4', freeze_id: 'F1' },
    { type: 'unfreeze', id: 'U3', ts: '2026-10-05T09:00:00Z', customer: 'C0001', bucket: 'b', amount: 1, note: 'REQ-5', freeze_id: 'F1' },
  ]);
  assert.equal(log[2].ok, false); // 301 > 300 unused
  assert.equal(log[2].error.code, 'E_CAP');
  assert.equal(log[3].ok, true);  // exactly the unused 300
  assert.equal(log[4].ok, false); // nothing unused left
  const b = eng.buckets.get('b');
  assert.deepEqual([b.available, b.frozen, b.used], [800, 0, 200]);
});

test('acceptance 3: same-amount same-timestamp freezes resolved by deterministic id tie-break', () => {
  const mk = (id) => frz(id, 600, { ts: '2026-10-01T09:00:00Z' });
  for (const input of [[mk('F-B'), mk('F-A')], [mk('F-A'), mk('F-B')]]) {
    const eng = makeEngine();
    const log = run(eng, input);
    const byId = Object.fromEntries(log.map((e) => [e.event.id, e]));
    assert.equal(byId['F-A'].ok, true);
    assert.equal(byId['F-B'].ok, false);
    assert.equal(byId['F-B'].error.code, 'E_CAP');
    assert.equal(eng.buckets.get('b').frozen, 600); // exactly one succeeded
  }
});

test('guard rules with when/unless execute on the VM', () => {
  const eng = makeEngine();
  const policy = compileSource(`
    customer C0001;
    note /^[A-Z0-9-]{3,32}$/;
    bucket b { limit 1000; }
    approval L1 { reject freeze when amount > 500 unless note matches /^VIP-/; }
  `);
  const e2 = new Engine(policy);
  const log = run(e2, [
    frz('F1', 600, { note: 'REQ-1' }),
    frz('F2', 600, { note: 'VIP-9', ts: '2026-10-01T10:00:00Z' }),
  ]);
  assert.equal(log[0].ok, false);
  assert.equal(log[0].error.code, 'E_CAP');
  assert.equal(log[1].ok, true);
  assert.equal(e2.buckets.get('b').frozen, 600);
  void eng;
});

test('unknown scope path is E_SCOPE, wrong customer is E_SCOPE', () => {
  const eng = makeEngine();
  const log = run(eng, [
    frz('F1', 100, { scope: ['L1', 'NOPE'] }),
    frz('F2', 100, { customer: 'C9999', ts: '2026-10-01T10:00:00Z' }),
  ]);
  assert.equal(log[0].error.code, 'E_SCOPE');
  assert.equal(log[1].error.code, 'E_SCOPE');
});

test('event sourcing: replaying the log reproduces the snapshot', () => {
  const eng = makeEngine();
  run(eng, [
    frz('F1', 500),
    { type: 'debit', id: 'D1', ts: '2026-10-02T09:00:00Z', customer: 'C0001', bucket: 'b', amount: 100, note: 'REQ-2', freeze_id: 'F1' },
    { type: 'business_day', id: 'BD1', date: '2027-01-01' },
  ]);
  const snap = eng.snapshot();
  const re = makeEngine();
  re.applyAll(eng.log.map((l) => l.event));
  assert.deepEqual(re.snapshot(), snap);
});
