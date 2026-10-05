import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store, canon } from '../src/store.js';

function sampleStore() {
  const s = new Store();
  s.ingest('shift1', [
    { id: 'e1', state: { valve: 'open' } },
    { id: 'e2', preds: ['e1'], state: [1, 2, 3] },
  ]);
  s.ingest('shift2', [{ id: 'e3', preds: ['e2'] }]);
  return s;
}

test('snapshot / restore round-trip preserves equivalence judgments', () => {
  const s = sampleStore();
  const text = s.snapshot();
  const r = Store.restore(text);
  assert.equal(r.status, 'OK');
  assert.equal(r.store.snapshot(), text);
  s.ingest('shift3', [{ id: 'e1' }, { id: 'e2', preds: ['e1'], state: [1, 2, 3] }]);
  const s2 = Store.restore(s.snapshot()).store;
  assert.equal(s2.equiv('shift1', 'shift3').status, s.equiv('shift1', 'shift3').status);
});

// Acceptance 5: truncated snapshot must be detected, in-memory state unchanged.
test('truncated snapshot -> RESTORE_CORRUPT, state unchanged', () => {
  const s = sampleStore();
  const text = s.snapshot();
  for (const cut of [1, text.length / 3, text.length / 2, text.length - 2]) {
    const r = Store.restore(text.slice(0, Math.max(1, Math.floor(cut))));
    assert.equal(r.status, 'RESTORE_CORRUPT', `cut=${cut}`);
  }
  const before = s.snapshot();
  const r2 = s.restoreFrom(text.slice(0, text.length - 5));
  assert.equal(r2.status, 'RESTORE_CORRUPT');
  assert.equal(s.snapshot(), before); // in-memory state untouched
});

test('tampered payload (checksum mismatch) -> RESTORE_CORRUPT', () => {
  const s = sampleStore();
  const doc = JSON.parse(s.snapshot());
  doc.payload.logs[0].events[0].state = { valve: 'closed' };
  const r = Store.restore(JSON.stringify(doc));
  assert.equal(r.status, 'RESTORE_CORRUPT');
  assert.match(r.error, /checksum/);
});

test('bad magic / wrong version / duplicate log_id in snapshot -> RESTORE_CORRUPT', () => {
  const s = sampleStore();
  const good = JSON.parse(s.snapshot());
  const badMagic = { ...good, magic: 'nope' };
  assert.equal(Store.restore(JSON.stringify(badMagic)).status, 'RESTORE_CORRUPT');
  const badVersion = { ...good, version: 99 };
  assert.equal(Store.restore(JSON.stringify(badVersion)).status, 'RESTORE_CORRUPT');
  const dup = JSON.parse(s.snapshot());
  dup.payload.logs.push(dup.payload.logs[0]);
  // recompute checksum so the duplicate-log_id structural check is what fails
  dup.checksum = createHash('sha256').update(canon(dup.payload)).digest('hex');
  const r = Store.restore(JSON.stringify(dup));
  assert.equal(r.status, 'RESTORE_CORRUPT');
  assert.match(r.error, /duplicate log_id/);
});

// Acceptance 5: duplicate log_id on ingest -> INVALID_INPUT.
test('duplicate log_id -> INVALID_INPUT', () => {
  const s = new Store();
  assert.equal(s.ingest('a', []).status, 'OK');
  const r = s.ingest('a', []);
  assert.equal(r.status, 'INVALID_INPUT');
  assert.match(r.error, /duplicate log_id/);
});

// Acceptance 5: empty log boundary cases.
test('empty logs: empty vs empty EQUAL; empty vs non-empty UNDECIDED', () => {
  const s = new Store();
  assert.equal(s.ingest('empty1', []).status, 'OK');
  assert.equal(s.ingest('empty2', []).status, 'OK');
  assert.equal(s.equiv('empty1', 'empty2').status, 'EQUAL');
  s.ingest('nonempty', [{ id: 'e1' }]);
  const r = s.equiv('empty1', 'nonempty');
  assert.equal(r.status, 'UNDECIDED');
  assert.ok(r.missing_edges_total >= 0);
});

test('invalid events -> INVALID_INPUT', () => {
  const s = new Store();
  assert.equal(s.ingest('a', [{ preds: [] }]).status, 'INVALID_INPUT'); // missing id
  assert.equal(s.ingest('b', [{ id: 1 }]).status, 'INVALID_INPUT'); // non-string id
  assert.equal(s.ingest('c', [{ id: 'x', preds: 'y' }]).status, 'INVALID_INPUT'); // bad preds
  assert.equal(s.ingest('d', 'not-an-array').status, 'INVALID_INPUT');
});
