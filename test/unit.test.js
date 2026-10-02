'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ExitError, EXIT, loadPolicy } = require('../src/model');
const { parseEvents } = require('../src/events');
const { decide, visibilityBitmap, evaluate } = require('../src/evaluate');

function basePolicy(overrides = {}) {
  return loadPolicy({
    tenants: {
      root: {},
      group: { parent: 'root' },
      t1: { parent: 'group' },
      t2: { parent: 'root' },
    },
    tags: ['line-1', 'safety-public'],
    devices: {
      dev1: { tags: ['line-1'] },
      dev2: { tags: ['line-1', 'safety-public'] },
    },
    grants: [
      { id: 'g1', tenant: 'group', tag: 'line-1', actions: ['read', 'modify', 'mark_false_positive'] },
    ],
    denies: [],
    exceptions: [],
    revocations: [],
    ...overrides,
  });
}

test('tenant group inheritance: grant on group applies to member tenant', () => {
  const p = basePolicy();
  const ev = { id: 'e1', ts: 1, device: 'dev1', type: 'fault' };
  assert.equal(decide(p, 't1', ev, 'read', 10).allow, true);
  assert.equal(decide(p, 't2', ev, 'read', 10).allow, false);
});

test('tenant cycle exits with code 4', () => {
  assert.throws(
    () => loadPolicy({ tenants: { a: { parent: 'b' }, b: { parent: 'a' } }, tags: [] }),
    (err) => err instanceof ExitError && err.exitCode === EXIT.TENANT_CYCLE
  );
});

test('unknown tag in grant exits with code 9', () => {
  assert.throws(
    () =>
      loadPolicy({
        tenants: { t: {} },
        tags: ['known'],
        grants: [{ id: 'g', tenant: 't', tag: 'nope', actions: ['read'] }],
      }),
    (err) => err.exitCode === EXIT.UNKNOWN_TAG
  );
});

test('unknown tag in device exits with code 9', () => {
  assert.throws(
    () => loadPolicy({ tenants: {}, tags: ['known'], devices: { d: { tags: ['ghost'] } } }),
    (err) => err.exitCode === EXIT.UNKNOWN_TAG
  );
});

test('events out of order beyond window exit with code 8', () => {
  const text = '{"id":"a","ts":1000}\n{"id":"b","ts":100}\n';
  assert.throws(() => parseEvents(text, 300), (err) => err.exitCode === EXIT.OUT_OF_ORDER);
  // within window is fine
  const ok = parseEvents('{"id":"a","ts":1000}\n{"id":"b","ts":800}\n', 300);
  assert.equal(ok.length, 2);
});

test('deny takes priority over allow', () => {
  const p = basePolicy({
    denies: [{ id: 'd1', tenant: 't1', tag: 'line-1', actions: ['read'] }],
  });
  const ev = { id: 'e1', ts: 1, device: 'dev1', type: 'fault' };
  const d = decide(p, 't1', ev, 'read', 10);
  assert.equal(d.allow, false);
  assert.deepEqual(d.counterexample.kind, 'extra-deny');
  assert.equal(d.counterexample.deny, 'd1');
});

test('safety-public tag breaks deny on shutdown events and records reason', () => {
  const p = basePolicy({
    denies: [{ id: 'd1', tenant: 't1', tag: 'line-1', actions: ['read'] }],
  });
  const shutdown = { id: 'e1', ts: 1, device: 'dev2', type: 'shutdown' };
  const d = decide(p, 't1', shutdown, 'read', 10);
  assert.equal(d.allow, true);
  assert.deepEqual(d.broken, ['d1']);
  assert.match(d.breakReason, /safety-public/);
  // non-shutdown event with same tags: deny still wins
  const fault = { id: 'e2', ts: 1, device: 'dev2', type: 'fault' };
  assert.equal(decide(p, 't1', fault, 'read', 10).allow, false);
  // break applies to read only, not modify
  const p2 = basePolicy({
    denies: [{ id: 'd1', tenant: 't1', tag: 'line-1', actions: ['modify'] }],
  });
  assert.equal(decide(p2, 't1', shutdown, 'modify', 10).allow, false);
});

test('event-level exception coexists with tag grants', () => {
  const p = basePolicy({
    exceptions: [
      { id: 'x1', event: 'e9', tenant: 't2', action: 'read', effect: 'allow' },
      { id: 'x2', event: 'e1', tenant: 't1', action: 'modify', effect: 'deny' },
    ],
  });
  const e9 = { id: 'e9', ts: 1, device: 'dev1', type: 'fault' };
  assert.equal(decide(p, 't2', e9, 'read', 10).allow, true); // exception allow without any tag grant
  const e1 = { id: 'e1', ts: 1, device: 'dev1', type: 'fault' };
  assert.equal(decide(p, 't1', e1, 'modify', 10).allow, false); // exception deny beats tag grant
  assert.equal(decide(p, 't1', e1, 'read', 10).allow, true); // other actions unaffected
});

test('revocation applies only at/after its ts; detail query rebuilt at query time', () => {
  const p = basePolicy({
    revocations: [{ id: 'r1', grant: 'g1', tenant: 't1', ts: 1000 }],
  });
  const ev = { id: 'e1', ts: 1, device: 'dev1', type: 'fault' };
  assert.equal(decide(p, 't1', ev, 'read', 500).allow, true);
  const after = decide(p, 't1', ev, 'read', 1500);
  assert.equal(after.allow, false);
  assert.equal(after.counterexample.kind, 'extra-revocation');
  assert.equal(after.counterexample.revocation, 'r1');
  // tenant-scoped revocation does not affect sibling tenant in same group
  const p2 = basePolicy({
    tenants: {
      root: {},
      group: { parent: 'root' },
      t1: { parent: 'group' },
      t1b: { parent: 'group' },
    },
    revocations: [{ id: 'r1', grant: 'g1', tenant: 't1', ts: 1000 }],
  });
  assert.equal(decide(p2, 't1b', ev, 'read', 1500).allow, true);
});

test('missing-grant counterexample names tenant, tag and action', () => {
  const p = basePolicy();
  const ev = { id: 'e1', ts: 1, device: 'dev1', type: 'fault' };
  const d = decide(p, 't2', ev, 'modify', 10);
  assert.equal(d.allow, false);
  assert.deepEqual(d.counterexample.grant, { tenant: 't2', tag: 'line-1', action: 'modify' });
});

test('visibility bitmap bits: read=1 modify=2 mark_false_positive=4', () => {
  const p = basePolicy();
  const ev = { id: 'e1', ts: 1, device: 'dev1', type: 'fault' };
  assert.equal(visibilityBitmap(p, 't1', ev, 10).bitmap, 7);
  assert.equal(visibilityBitmap(p, 't2', ev, 10).bitmap, 0);
});
