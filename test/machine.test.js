'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine, runStream } from '../src/machine.js';
import { runCli } from '../src/cli.js';

const ev = (type, id) => (id === undefined ? { type } : { type, id });

function runEvents(events) {
  const m = new Machine();
  for (const e of events) m.ingest(e);
  return m;
}

// Acceptance 1: enumerate all legal executions of length <= 9 and check the
// three stock counters against item statuses at every reachable state.
// Two exhaustive BFS tiers keep the reachable-state space finite:
//  A) full verdict/rework alphabet incl. orphan producers, no control events
//     (state is fully determined by item statuses);
//  B) shutdown/restart control events with a single-item alphabet (the pending
//     queue is part of the state, so dedup still collapses reruns).
function enumerateAll(alphabet, maxDepth) {
  const seen = new Set();
  let frontier = [new Machine()];
  seen.add(frontier[0].key());
  let checked = 0;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next = [];
    for (const machine of frontier) {
      for (const event of alphabet) {
        const m = machine.cloneBare();
        m.ingest(event);
        assert.ok(m.invariantsHold(),
          `invariants broken at depth ${depth + 1} by ${JSON.stringify(event)}: ${JSON.stringify(m.state())}`);
        checked += 1;
        const key = m.key();
        if (!seen.has(key)) {
          seen.add(key);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return { checked, states: seen.size };
}

test('enumeration: verdict/rework sequences length <= 9 keep stock consistent', () => {
  const { checked, states } = enumerateAll([
    ev('inspect', 'a'), ev('inspect', 'b'),
    ev('reject', 'a'), ev('accept', 'a'),
    ev('reject', 'b'), ev('accept', 'b'),
    ev('rework_start', 'a'), ev('rework_done', 'a'),
    ev('rework_start', 'b'), ev('rework_done', 'b'),
    ev('void_inspect', 'a'), ev('void_inspect', 'b'),
    ev('reject', 'ghost'), ev('accept', 'ghost'), // orphan producers
  ], 9);
  console.log(`  tier A: ${checked} executions checked, ${states} distinct states`);
});

test('enumeration: shutdown/restart sequences length <= 9 keep stock consistent', () => {
  const { checked, states } = enumerateAll([
    ev('inspect', 'a'), ev('reject', 'a'),
    ev('rework_start', 'a'), ev('rework_done', 'a'),
    ev('void_inspect', 'a'),
    ev('shutdown'), ev('restart'),
  ], 9);
  console.log(`  tier B: ${checked} executions checked, ${states} distinct states`);
});

// Acceptance 2: repeated reject on one inspect, then void -> rollback exactly once.
test('duplicate reject then void rolls back exactly once', () => {
  const m = runEvents([
    ev('inspect', 'i1'),
    ev('reject', 'i1'),
    ev('reject', 'i1'),
    ev('reject', 'i1'),
    ev('void_inspect', 'i1'),
  ]);
  assert.equal(m.errors.length, 0);
  assert.equal(m.duplicates, 2); // repeated rejects are idempotent no-ops
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 0, defective: 0, rework: 0 },
  );
  assert.equal(m.items.get('i1'), 'voided');
  const kinds = m.moves.map((mv) => mv.move);
  assert.deepEqual(kinds, ['reject', 'void']); // one reject applied, one void rollback
  // A second void is also an idempotent no-op: nothing left to roll back.
  m.ingest(ev('void_inspect', 'i1'));
  assert.equal(m.errors.length, 0);
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 0, defective: 0, rework: 0 },
  );
});

// Acceptance 3: reject -> rework_start -> void_inspect yields reverse_rework,
// good stock never appears out of thin air.
test('void after rework_start compensates with reverse_rework', () => {
  const m = runEvents([
    ev('inspect', 'i1'),
    ev('reject', 'i1'),
    ev('rework_start', 'i1'),
    ev('void_inspect', 'i1'),
  ]);
  assert.equal(m.errors.length, 0);
  const kinds = m.moves.map((mv) => mv.move);
  assert.deepEqual(kinds, ['reject', 'rework_start', 'reverse_rework']);
  assert.ok(m.moves.every((mv) => mv.good === 0), 'good stock must stay 0');
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 0, defective: 1, rework: 0 },
  );
  assert.equal(m.items.get('i1'), 'rejected'); // history kept, item back to defective
});

test('void after rework_done reverses into defective, good returns to 0', () => {
  const m = runEvents([
    ev('inspect', 'i1'),
    ev('reject', 'i1'),
    ev('rework_start', 'i1'),
    ev('rework_done', 'i1'),
    ev('void_inspect', 'i1'),
  ]);
  assert.equal(m.errors.length, 0);
  assert.equal(m.moves.at(-1).move, 'reverse_rework');
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 0, defective: 1, rework: 0 },
  );
});

// Acceptance 4: rework_done during shutdown takes effect after restart, in order.
test('rework_done during shutdown applies after restart, order preserved', () => {
  const m = runEvents([
    ev('inspect', 'i1'),   // seq 1
    ev('reject', 'i1'),    // seq 2
    ev('rework_start', 'i1'), // seq 3
    ev('shutdown'),        // seq 4
    ev('rework_done', 'i1'),  // seq 5, queued while down
    ev('restart'),         // seq 6
  ]);
  assert.equal(m.errors.length, 0);
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 1, defective: 0, rework: 0 },
  );
  const kinds = m.moves.map((mv) => mv.move);
  assert.deepEqual(kinds, ['reject', 'rework_start', 'shutdown', 'restart', 'rework_done']);
  // Order is provable: the queued rework_done keeps its original seq (5) and is
  // applied only after the restart marker (seq 6).
  const restartIdx = m.moves.findIndex((mv) => mv.move === 'restart');
  const doneIdx = m.moves.findIndex((mv) => mv.move === 'rework_done');
  assert.ok(doneIdx > restartIdx);
  assert.equal(m.moves[doneIdx].seq, 5);
  // No inventory move between shutdown and restart.
  const shutdownIdx = m.moves.findIndex((mv) => mv.move === 'shutdown');
  assert.ok(m.moves.slice(shutdownIdx + 1, restartIdx).every((mv) => mv.move === 'restart' || mv.move === 'shutdown'));
  // Seq numbers in applied moves never go backwards across the restart merge.
  const applied = m.moves.filter((mv) => !['shutdown', 'restart'].includes(mv.move));
  assert.deepEqual(applied.map((mv) => mv.seq), [2, 3, 5]);
});

test('stream ending while shutdown leaves events pending and unapplied', () => {
  const m = runEvents([
    ev('inspect', 'i1'),
    ev('reject', 'i1'),
    ev('shutdown'),
    ev('rework_start', 'i1'),
  ]);
  assert.equal(m.running, false);
  assert.equal(m.pendingQueue.length, 1);
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 0, defective: 1, rework: 0 },
  );
  // Late restart still merges the queued event in original order.
  m.ingest(ev('restart'));
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 0, defective: 0, rework: 1 },
  );
});

test('errors: orphan_reject and double_consume recorded, legal events continue', () => {
  const m = runEvents([
    ev('reject', 'nope'),       // orphan_reject
    ev('inspect', 'i1'),
    ev('accept', 'i1'),
    ev('reject', 'i1'),         // double_consume (conflicting verdict)
    ev('rework_start', 'i1'),   // invalid_state (accepted, not rejected)
    ev('inspect', 'i2'),
    ev('reject', 'i2'),
    ev('rework_start', 'i2'),
    ev('rework_start', 'i2'),   // double_consume
  ]);
  assert.deepEqual(m.errors.map((e) => e.code),
    ['orphan_reject', 'double_consume', 'invalid_state', 'double_consume']);
  assert.deepEqual(
    { good: m.good, defective: m.defective, rework: m.rework },
    { good: 1, defective: 0, rework: 1 },
  );
});

test('cli: run writes state.json/moves.jsonl/errors.jsonl, exit=2 on errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visionline-'));
  const stream = join(dir, 'stream.jsonl');
  const out = join(dir, 'out');
  writeFileSync(stream, [
    JSON.stringify(ev('inspect', 'a')),
    JSON.stringify(ev('reject', 'a')),
    JSON.stringify(ev('reject', 'ghost')), // orphan_reject -> exit 2
    JSON.stringify(ev('rework_start', 'a')),
    JSON.stringify(ev('rework_done', 'a')),
    '',
  ].join('\n'));

  const lines = [];
  const exit = runCli(['run', '--stream', stream, '--out', out],
    { log: (m) => lines.push(m), error: (m) => lines.push(m) });
  assert.equal(exit, 2);

  const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
  assert.deepEqual(
    { good: state.good, defective: state.defective, rework: state.rework },
    { good: 1, defective: 0, rework: 0 },
  );
  const errors = readFileSync(join(out, 'errors.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(errors.map((e) => e.code), ['orphan_reject']);
  const moves = readFileSync(join(out, 'moves.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(moves.map((mv) => mv.move), ['reject', 'rework_start', 'rework_done']);
});

test('cli: clean stream exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visionline-'));
  const stream = join(dir, 'stream.jsonl');
  const out = join(dir, 'out');
  writeFileSync(stream, [
    JSON.stringify(ev('inspect', 'a')),
    JSON.stringify(ev('accept', 'a')),
    '',
  ].join('\n'));
  const exit = runCli(['run', '--stream', stream, '--out', out],
    { log: () => {}, error: () => {} });
  assert.equal(exit, 0);
  const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
  assert.equal(state.good, 1);
});

test('cli: usage error exits 1', () => {
  const exit = runCli(['run', '--stream', '/nonexistent.jsonl', '--out', '/tmp/x'],
    { log: () => {}, error: () => {} });
  assert.equal(exit, 1);
  assert.equal(runCli([], { log: () => {}, error: () => {} }), 1);
});

test('runStream: bad json line recorded, later events still processed', () => {
  const m = runStream('{"type":"inspect","id":"a"}\nnot-json\n{"type":"accept","id":"a"}\n');
  assert.deepEqual(m.errors.map((e) => e.code), ['bad_json']);
  assert.equal(m.good, 1);
});
