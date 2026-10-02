'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processBytes, Processor } = require('../src/processor');
const { start, end, undo, stream } = require('../testlib/helpers');

// Acceptance 1: sticky + half-frame recovery reproduces the reference
// event enumeration exactly, regardless of chunking.
test('acceptance 1: sticky/half-frame recovery matches reference enumeration', () => {
  const buf = stream(
    start('WO-1', 0), end('WO-1', 1),
    start('WO-2', 2), end('WO-2', 3), undo('WO-2', 4),
    start('WO-1', 5), end('WO-1', 6),
  );
  const reference = [
    ['weld_start', 'WO-1'],
    ['weld_end', 'WO-1'],
    ['weld_start', 'WO-2'],
    ['weld_end', 'WO-2'],
    ['weld_undo', 'WO-2'],
    ['weld_start', 'WO-1'],
    ['weld_end', 'WO-1'],
  ];

  const oneShot = processBytes(buf);
  assert.equal(oneShot.exitCode, 0);
  assert.deepEqual(oneShot.events.map((e) => [e.type, e.wo]), reference);
  assert.equal(oneShot.events[4].undoes, 4); // undo reverses weld_end id 4

  // Brute-force replay: every two-way chunking must give identical output.
  for (let cut = 0; cut <= buf.length; cut++) {
    const p = new Processor();
    const events = [];
    events.push(...p.push(buf.subarray(0, cut)).events);
    events.push(...p.push(buf.subarray(cut)).events);
    const done = p.finish();
    events.push(...done.events);
    assert.equal(done.error, null, `cut ${cut}`);
    assert.deepEqual(events.map((e) => [e.type, e.wo]), reference, `cut ${cut}`);
  }
});

// Acceptance 2: duplicate seqs and timeout retransmissions never double-post.
test('acceptance 2: duplicates and retransmissions are not double-posted', () => {
  const f0 = start('WO-1', 0);
  const f1 = end('WO-1', 1);
  const buf = stream(f0, f0, f1, f1, f0); // heavy duplication
  const r = processBytes(buf);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.events.map((e) => e.type), ['weld_start', 'weld_end']);
  assert.equal(r.certificate.duplicates, 3);
  assert.equal(r.certificate.events, 2);
});

test('acceptance 2: out-of-order gap triggers NAK, retry, and single posting', () => {
  const f0 = start('WO-1', 0);
  const f1 = end('WO-1', 1);
  const f2 = start('WO-2', 2);
  // seq 1 arrives late (retransmitted), seq 2 arrives early (buffered).
  const buf = stream(f0, f2, f1, f1);
  const r = processBytes(buf, { timeout: 3 });
  assert.equal(r.exitCode, 0);
  const types = r.events.map((e) => e.type);
  assert.equal(types[0], 'weld_start'); // seq 0
  assert.equal(types[1], 'retransmit_request'); // gap at seq 1
  assert(types.includes('retransmit_retry'), 'virtual clock fired a retry');
  // Domain events exactly once, in seq order, after the gap closed.
  assert.deepEqual(
    r.events.filter((e) => e.wo).map((e) => [e.type, e.wo, e.seq]),
    [['weld_start', 'WO-1', 0], ['weld_end', 'WO-1', 1], ['weld_start', 'WO-2', 2]],
  );
  assert.equal(r.certificate.duplicates, 1);
  assert.equal(r.certificate.retransmitRequests, 1);
  assert(r.certificate.retries >= 1);
});

test('acceptance 2: permanent gap is a SEQ_GAP protocol violation', () => {
  const buf = stream(start('WO-1', 0), start('WO-2', 2)); // seq 1 never comes
  const r = processBytes(buf);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.error, { code: 'SEQ_GAP', offset: buf.length });
});

// Acceptance 3: illegal UNDO fails with exit 3 and leaves state unchanged.
test('acceptance 3: cross-work-order UNDO fails, state unchanged', () => {
  const buf = stream(start('WO-A', 0), end('WO-A', 1), undo('WO-B', 2));
  const r = processBytes(buf);
  assert.equal(r.exitCode, 3);
  assert.equal(r.error.code, 'UNDO_NOT_ALLOWED');
  assert.equal(r.error.offset, start('WO-A', 0).length + end('WO-A', 1).length);
  // Only the two legitimate events were posted; no weld_undo.
  assert.deepEqual(r.events.map((e) => e.type), ['weld_start', 'weld_end']);
});

test('acceptance 3: UNDO of already-closed (undone) END fails', () => {
  const buf = stream(start('WO-A', 0), end('WO-A', 1), undo('WO-A', 2), undo('WO-A', 3));
  const r = processBytes(buf);
  assert.equal(r.exitCode, 3);
  assert.equal(r.error.code, 'UNDO_NOT_ALLOWED');
  assert.deepEqual(r.events.map((e) => e.type), ['weld_start', 'weld_end', 'weld_undo']);
});

test('acceptance 3: UNDO covered by a later START fails', () => {
  const buf = stream(start('WO-A', 0), end('WO-A', 1), start('WO-A', 2), undo('WO-A', 3));
  const r = processBytes(buf);
  assert.equal(r.exitCode, 3);
  assert.equal(r.error.code, 'UNDO_NOT_ALLOWED');
  assert.deepEqual(r.events.map((e) => e.type), ['weld_start', 'weld_end', 'weld_start']);
});

test('acceptance 3: WELD_END without open START fails', () => {
  const r = processBytes(stream(end('WO-A', 0)));
  assert.equal(r.exitCode, 3);
  assert.equal(r.error.code, 'END_WITHOUT_START');
  assert.equal(r.events.length, 0);
});

test('undo keeps the original event and emits a reverse event', () => {
  const r = processBytes(stream(start('WO-A', 0), end('WO-A', 1), undo('WO-A', 2)));
  assert.equal(r.exitCode, 0);
  const [s, e, u] = r.events;
  assert.equal(u.type, 'weld_undo');
  assert.equal(u.undoes, e.id); // reverse event points at the kept original
  assert.equal(r.certificate.events, 3);
  assert.equal(r.certificate.openWorkOrders.length, 0);
});
