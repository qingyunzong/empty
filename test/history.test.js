import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History, compareEvents } from '../src/history.js';

const ev = (id, over = {}) => ({
  id,
  account: 'acct-1',
  day: '2026-10-03',
  lamport: 1,
  source: 'reconciler',
  seq: 1,
  kind: 'repair',
  ...over,
});

test('linearization orders by lamport, then source, then seq', () => {
  const h = new History();
  h.record(ev('e1', { lamport: 1, source: 'a', seq: 1 }));
  h.record(ev('e2', { lamport: 2, source: 'a', seq: 2 }));
  const manual = new History();
  // Concurrent event from another source must chain via supersedes.
  manual.record(ev('e1', { lamport: 5, source: 'b', seq: 1 }));
  manual.record(ev('e2', { lamport: 3, source: 'a', seq: 1, supersedes: 'e1' }));
  const ordered = manual.linearize('acct-1', '2026-10-03');
  assert.deepEqual(ordered.map((e) => e.id), ['e2', 'e1'], 'lamport dominates record order');
  assert.ok(compareEvents(ev('x', { lamport: 1, source: 'a', seq: 2 }), ev('y', { lamport: 1, source: 'b', seq: 1 })) < 0);
});

test('same-source monotonic events are clean continuations', () => {
  const h = new History();
  h.record(ev('e1', { lamport: 1, seq: 1 }));
  h.record(ev('e2', { lamport: 2, seq: 2 }));
  assert.equal(h.headId('acct-1', '2026-10-03'), 'e2');
});

test('concurrent event in the same domain raises CONFLICT_DOMAIN', () => {
  const h = new History();
  h.record(ev('e1', { lamport: 1, source: 'reconciler', seq: 1 }));
  assert.throws(
    () => h.record(ev('e2', { lamport: 2, source: 'manual-ops', seq: 1 })),
    (e) => e.code === 'CONFLICT_DOMAIN' && e.details.head === 'e1',
  );
  // Non-monotonic same-source event is also concurrent.
  assert.throws(
    () => h.record(ev('e3', { lamport: 1, source: 'reconciler', seq: 1 })),
    (e) => e.code === 'CONFLICT_DOMAIN',
  );
});

test('sealed domain rejects late writes with SEALED', () => {
  const h = new History();
  h.record(ev('e1'));
  h.seal('acct-1', '2026-10-03');
  assert.throws(
    () => h.record(ev('late-1', { lamport: 9, seq: 9 })),
    (e) => e.code === 'SEALED' && e.details.domain === 'acct-1@2026-10-03',
  );
});

test('supersedes chain may rewrite a sealed day', () => {
  const h = new History();
  h.record(ev('e1'));
  h.seal('acct-1', '2026-10-03');
  h.record(ev('fix-1', { lamport: 10, source: 'manual-ops', seq: 1, supersedes: 'e1' }));
  h.record(ev('fix-2', { lamport: 11, source: 'manual-ops', seq: 2, supersedes: 'fix-1' }));
  assert.equal(h.headId('acct-1', '2026-10-03'), 'fix-2');
  // A supersedes pointer that skips the head is not a chain.
  assert.throws(
    () => h.record(ev('fix-3', { lamport: 12, source: 'manual-ops', seq: 3, supersedes: 'e1' })),
    (e) => e.code === 'SEALED',
  );
});

test('conflict domains are isolated per account+day', () => {
  const h = new History();
  h.record(ev('e1', { account: 'a', day: '2026-10-03' }));
  h.record(ev('e2', { account: 'a', day: '2026-10-04', lamport: 1, seq: 1 }));
  h.record(ev('e3', { account: 'b', day: '2026-10-03', lamport: 1, seq: 1 }));
  h.seal('a', '2026-10-03');
  assert.ok(h.isSealed('a', '2026-10-03'));
  assert.ok(!h.isSealed('a', '2026-10-04'));
  assert.ok(!h.isSealed('b', '2026-10-03'));
});
