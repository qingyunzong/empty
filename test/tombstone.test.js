import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyEvent, mergeStates, canonicalState, observable } from '../src/state.js';

const DT = { id: 'd1', type: 'downtime', node: 't1', start: 100, end: 200 };
const REVOKE = { id: 'v1', type: 'revoke', target: 'd1', node: 't1' };

// Acceptance 3: tombstones prevent duplicate deletes and resurrection.
test('duplicate revoke is idempotent', () => {
  const s = emptyState();
  applyEvent(s, DT);
  applyEvent(s, REVOKE);
  const once = JSON.stringify(observable(s));
  applyEvent(s, { ...REVOKE, id: 'v2' }); // second terminal revokes again
  applyEvent(s, { ...REVOKE, id: 'v3' });
  assert.equal(JSON.stringify(observable(s)), once);
  assert.equal(s.tombstones.d1, true);
  assert.equal(Object.keys(s.downtimes).length, 0);
});

test('re-applying the identical revoke event is a full no-op', () => {
  const s = emptyState();
  applyEvent(s, DT);
  applyEvent(s, REVOKE);
  const once = canonicalState(s);
  applyEvent(s, REVOKE);
  assert.equal(canonicalState(s), once);
});

test('tombstone wins over late/arriving downtime (remove-wins)', () => {
  const revoked = emptyState();
  applyEvent(revoked, DT);
  applyEvent(revoked, REVOKE);
  // The same downtime event re-arrives from a lagging peer.
  applyEvent(revoked, DT);
  assert.equal(Object.keys(revoked.downtimes).length, 0);

  // Merge order does not matter: downtime-only state merged with tombstoned state.
  const withDt = emptyState();
  applyEvent(withDt, DT);
  const tombstoned = emptyState();
  applyEvent(tombstoned, REVOKE);
  for (const [a, b] of [[withDt, tombstoned], [tombstoned, withDt]]) {
    const merged = mergeStates(a, b);
    assert.equal(Object.keys(merged.downtimes).length, 0);
    assert.equal(merged.tombstones.d1, true);
  }
});

test('tombstones survive further merges (no resurrection after anti-entropy)', () => {
  const a = emptyState();
  applyEvent(a, DT);
  applyEvent(a, REVOKE);
  const b = emptyState();
  applyEvent(b, DT);
  const m1 = mergeStates(a, b);
  const m2 = mergeStates(m1, b); // merging the "live" copy again must not resurrect
  assert.equal(Object.keys(m2.downtimes).length, 0);
});
