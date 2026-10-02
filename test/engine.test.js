import test from 'node:test';
import assert from 'node:assert/strict';
import { runStream } from '../src/run.js';

function run(lines) {
  return runStream(lines.map((l) => JSON.stringify(l)).join('\n'));
}

test('accept/reject are idempotent and paired with inspect', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'accept', id: 'a' },
    { type: 'accept', id: 'a' },
    { type: 'accept', id: 'a' },
    { type: 'inspect', id: 'b' },
    { type: 'reject', id: 'b' },
    { type: 'reject', id: 'b' },
  ]);
  assert.deepEqual(r.state, { good: 1, defective: 1, rework: 0, pending: 0 });
  assert.equal(r.errors.length, 0);
});

test('orphan_reject is an error, stream continues', () => {
  const r = run([
    { type: 'reject', id: 'ghost' },
    { type: 'inspect', id: 'a' },
    { type: 'accept', id: 'a' },
  ]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].error, 'orphan_reject');
  assert.deepEqual(r.state, { good: 1, defective: 0, rework: 0, pending: 0 });
});

test('conflicting result does not change inventory', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'accept', id: 'a' },
  ]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].error, 'conflicting_result');
  assert.deepEqual(r.state, { good: 0, defective: 1, rework: 0, pending: 0 });
});

test('double_consume on repeated rework_start / rework_done', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'rework_start', id: 'a' },
    { type: 'rework_start', id: 'a' },
    { type: 'rework_done', id: 'a' },
    { type: 'rework_done', id: 'a' },
  ]);
  assert.deepEqual(r.state, { good: 1, defective: 0, rework: 0, pending: 0 });
  assert.deepEqual(r.errors.map((e) => e.error), ['double_consume', 'double_consume']);
});

// Acceptance 2: duplicate rejects then a single void rolls back exactly once.
test('acceptance 2: repeated reject then void_inspect rolls back once', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'void_inspect', id: 'a' },
  ]);
  assert.deepEqual(r.state, { good: 0, defective: 0, rework: 0, pending: 0 });
  assert.equal(r.errors.length, 0);
  const kinds = r.moves.map((m) => m.kind);
  assert.deepEqual(kinds, ['reject', 'void_reject']);
  // a second void is an error and changes nothing
    const r2 = run([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'void_inspect', id: 'a' },
    { type: 'void_inspect', id: 'a' },
  ]);
  assert.deepEqual(r2.state, { good: 0, defective: 0, rework: 0, pending: 0 });
  assert.equal(r2.errors.length, 1);
  assert.equal(r2.errors[0].error, 'double_void');
});

// Acceptance 3: reject -> rework_start -> void_inspect emits reverse_rework
// and good inventory must not appear out of nowhere.
test('acceptance 3: void after rework_start yields reverse_rework, no phantom good', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'rework_start', id: 'a' },
    { type: 'void_inspect', id: 'a' },
  ]);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.state, { good: 0, defective: 0, rework: 0, pending: 0 });
  const kinds = r.moves.map((m) => m.kind);
  assert.deepEqual(kinds, ['reject', 'rework_start', 'reverse_rework']);
  const reverse = r.moves.find((m) => m.kind === 'reverse_rework');
  assert.deepEqual(reverse.delta, { rework: -1 });
  // good never went positive at any point
  for (const m of r.moves) assert.ok(m.state.good >= 0);
  assert.equal(r.state.good, 0);
});

// Acceptance 4: rework_done arriving during shutdown stays pending and takes
// effect after restart, in provable original order.
test('acceptance 4: pending rework_done applies after restart, order preserved', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'rework_start', id: 'a' },
    { type: 'inspect', id: 'b' },
    { type: 'reject', id: 'b' },
    { type: 'shutdown' },
    { type: 'rework_done', id: 'a' }, // seq 7, pending
    { type: 'rework_start', id: 'b' }, // seq 8, pending
    { type: 'restart' }, // seq 9
  ]);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.state, { good: 1, defective: 0, rework: 1, pending: 0 });

  // Order proof: pending events keep their original seq and are applied
  // (applySeq) after the restart record, in arrival order.
  const restart = r.moves.find((m) => m.kind === 'restart');
  const pendingMoves = r.moves.filter((m) => m.seq === 7 || m.seq === 8);
  assert.deepEqual(pendingMoves.map((m) => m.kind), ['rework_done', 'rework_start']);
  assert.deepEqual(pendingMoves.map((m) => m.seq), [7, 8]);
  for (const m of pendingMoves) assert.ok(m.applySeq > restart.applySeq);
  assert.ok(pendingMoves[0].applySeq < pendingMoves[1].applySeq);
});

test('events after shutdown stay pending if stream ends without restart', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'accept', id: 'a' },
    { type: 'shutdown' },
    { type: 'inspect', id: 'b' },
    { type: 'accept', id: 'b' },
  ]);
  assert.deepEqual(r.state, { good: 1, defective: 0, rework: 0, pending: 2 });
});

test('a shutdown inside the pending queue re-parks the remaining events', () => {
  const r = run([
    { type: 'shutdown' },
    { type: 'inspect', id: 'a' },
    { type: 'shutdown' }, // queued; re-shuts-down during drain
    { type: 'accept', id: 'a' }, // stays pending
    { type: 'restart' },
  ]);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.state, { good: 0, defective: 0, rework: 0, pending: 1 });
});

test('bad json lines become errors and the stream continues', () => {
  const text = [
    JSON.stringify({ type: 'inspect', id: 'a' }),
    '{not json',
    JSON.stringify({ type: 'accept', id: 'a' }),
  ].join('\n');
  const r = runStream(text);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].error, 'bad_json');
  assert.equal(r.errors[0].seq, 2);
  assert.deepEqual(r.state, { good: 1, defective: 0, rework: 0, pending: 0 });
});

test('void of an accepted item decrements good exactly once', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'accept', id: 'a' },
    { type: 'accept', id: 'a' },
    { type: 'void_inspect', id: 'a' },
  ]);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.state, { good: 0, defective: 0, rework: 0, pending: 0 });
});

test('void after rework_done is rejected as already_consumed', () => {
  const r = run([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'rework_start', id: 'a' },
    { type: 'rework_done', id: 'a' },
    { type: 'void_inspect', id: 'a' },
  ]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].error, 'already_consumed');
  assert.deepEqual(r.state, { good: 1, defective: 0, rework: 0, pending: 0 });
});
