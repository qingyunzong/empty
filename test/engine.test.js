'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ev, close, writeFrames, runCli } = require('./helpers');
const { Engine } = require('../lib/engine');

// Acceptance 1: same-key resend is deduplicated idempotently.
test('acceptance 1: identical resend dedups, balance applied once', () => {
  const { file } = writeFrames([ev('e1', 'A', 100, 1, 1), ev('e1', 'A', 100, 1, 1), ev('e1', 'A', 100, 1, 1)]);
  const r = runCli(file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).balances.A, 100);
});

test('duplicate eventId with different payload exits 3', () => {
  const { file } = writeFrames([ev('e1', 'A', 100, 1, 1), ev('e1', 'A', 999, 1, 1)]);
  const r = runCli(file);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /different payload/);
});

// Acceptance 2: correction chain (reversal+replacement) affects later balances.
test('acceptance 2: correction chain affects subsequent balance', () => {
  const { file } = writeFrames([
    ev('e1', 'A', 100, 1, 1),
    ev('e2', 'A', 80, 2, 2, { replaces: 'e1' }),
    ev('e3', 'A', 50, 3, 3),
    ev('e4', 'A', 30, 4, 4, { replaces: 'e2' }), // correction of a correction
  ]);
  const r = runCli(file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).balances.A, 100 - 100 + 80 - 80 + 30 + 50);
});

test('posted entries are immutable; corrections append linked reversal+replacement', () => {
  const engine = new Engine();
  engine.accept(ev('e1', 'A', 100, 1, 1));
  engine.accept(ev('e2', 'A', 80, 2, 2, { replaces: 'e1' }));
  engine.accept(close('P1', 10));
  engine.finalize();
  const kinds = engine.entries.map((e) => [e.kind, e.id, e.of || null, e.amount]);
  assert.deepEqual(kinds, [
    ['post', 'e1', null, 100],
    ['reversal', 'e2:rev', 'e1', -100],
    ['replacement', 'e2', 'e1', 80],
  ]);
  assert.equal(engine.entries[0].amount, 100); // original untouched
});

test('double correction of the same target is rejected', () => {
  const engine = new Engine();
  engine.accept(ev('e1', 'A', 100, 1, 1));
  engine.accept(ev('e2', 'A', 80, 2, 2, { replaces: 'e1' }));
  engine.accept(ev('e3', 'A', 70, 3, 3, { replaces: 'e1' }));
  assert.throws(() => engine.accept(close('P1', 10)), /already corrected/);
});

// Acceptance 3: close boundary — late events go to the next period,
// frozen balances are never reopened.
test('acceptance 3: late event after close settles in next period, P1 frozen', () => {
  const { file, dir } = writeFrames([
    ev('e1', 'A', 100, 1, 50),
    close('P1', 100),
    ev('e2', 'A', 40, 2, 80), // logicalTs <= P1 cutoff but arrived after close
  ]);
  const r = runCli(file);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.balances.A, 140);
  assert.equal(out.periods.length, 2);
  assert.equal(out.periods[0].periodId, 'P1');
  assert.equal(out.periods[1].entries, 1);
  const fs = require('fs');
  const p1 = JSON.parse(fs.readFileSync(out.periods[0].cert, 'utf8'));
  assert.equal(p1.balances.A, 100); // frozen
  const p2 = JSON.parse(fs.readFileSync(out.periods[1].cert, 'utf8'));
  assert.equal(p2.log[0].late, true);
  assert.equal(p2.balances.A, 140);
  assert.equal(out.pending.length, 1);
  assert.equal(out.pending[0].eventId, 'e2');
  assert.equal(out.pending[0].settledIn, 'P2');
});

test('event beyond cutoff waits for a future period', () => {
  const engine = new Engine();
  engine.accept(ev('e1', 'A', 100, 1, 50));
  engine.accept(ev('e2', 'A', 5, 2, 500)); // beyond cutoff
  engine.accept(close('P1', 100));
  assert.equal(engine.periods[0].entries.length, 1);
  engine.finalize();
  assert.equal(engine.periods.length, 2);
  assert.equal(engine.periods[1].entries[0].id, 'e2');
  assert.equal(engine.periods[1].entries[0].late, false);
});

test('re-closing a period with a different cutoff exits 3', () => {
  const { file } = writeFrames([close('P1', 100), close('P1', 200)]);
  assert.equal(runCli(file).status, 3);
});

// Sequence gaps: out-of-order within window is buffered; beyond window exits 4.
test('out-of-order within window is reordered by branchSeq', () => {
  const { file } = writeFrames([ev('e2', 'A', 2, 2, 2), ev('e1', 'A', 1, 1, 1), ev('e3', 'A', 3, 3, 3)]);
  const r = runCli(file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).balances.A, 6);
});

test('acceptance: missing sequence beyond window exits 4', () => {
  const { file } = writeFrames([ev('e1', 'A', 1, 1, 1), ev('e2', 'A', 2, 20, 2)]);
  const r = runCli(file);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /beyond window/);
});

test('unfilled gap at end of input exits 4', () => {
  const { file } = writeFrames([ev('e1', 'A', 1, 1, 1), ev('e3', 'A', 3, 3, 3)]);
  const r = runCli(file);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /unfilled sequence gap/);
});

test('reused branchSeq with different eventId exits 4', () => {
  const { file } = writeFrames([ev('e1', 'A', 1, 1, 1), ev('e9', 'A', 9, 1, 2)]);
  assert.equal(runCli(file).status, 4);
});

// Causal ordering and cycle rejection.
test('cyclic causality across accounts is rejected with exit 5', () => {
  const { file } = writeFrames([
    ev('e1', 'A', 1, 1, 1, { causes: ['e2'] }),
    ev('e2', 'B', 2, 1, 2, { causes: ['e1'] }),
  ]);
  const r = runCli(file);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /cyclic causality/);
});

test('self-causation is rejected with exit 5', () => {
  const { file } = writeFrames([ev('e1', 'A', 1, 1, 1, { causes: ['e1'] })]);
  assert.equal(runCli(file).status, 5);
});

test('cross-account concurrency is linearized by logicalTs then eventId', () => {
  const engine = new Engine();
  engine.accept(ev('e2', 'B', 1, 1, 5));
  engine.accept(ev('e1', 'A', 1, 1, 5)); // same ts, smaller id wins
  engine.accept(ev('e3', 'C', 1, 1, 3));
  engine.accept(close('P1', 10));
  engine.finalize();
  assert.deepEqual(engine.entries.map((e) => e.id), ['e3', 'e1', 'e2']);
});

test('causes edge enforces cross-account happens-before', () => {
  const engine = new Engine();
  engine.accept(ev('e1', 'A', 1, 1, 9));
  engine.accept(ev('e2', 'B', 1, 1, 1, { causes: ['e1'] })); // earlier ts but caused by e1
  engine.accept(close('P1', 10));
  engine.finalize();
  assert.deepEqual(engine.entries.map((e) => e.id), ['e1', 'e2']);
});
