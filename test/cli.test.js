import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, EXIT } from '../src/cli.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through runCli(argv, stdinText); real process exit codes were
// verified via shell (0 / 17 / 18 / 2).

const toJsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n');

const WAVE_INPUT = toJsonl([
  { type: 'wave', id: 'w1', budget: 20 },
  { type: 'shuttle', id: 's1', battery: 20 },
  { type: 'task', id: 't1', routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 6, duration: 4 }] }] },
  { type: 'task', id: 't2', routes: [{ moves: [{ from: 'C', to: 'D', lane: 'L2', energy: 8, duration: 3 }] }] },
]);

test('wave command emits a JSONL plan and exits 0', () => {
  const { exitCode, records } = runCli(['wave'], WAVE_INPUT);
  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(records[0], { type: 'wave', id: 'w1', budget: 20 });
  const plan = records.find((r) => r.type === 'plan');
  assert.equal(plan.energy, 14);
  assert.equal(plan.makespan, 7);
  assert.equal(records.filter((r) => r.type === 'move').length, 2);
  assert.ok(records.filter((r) => r.type === 'move').every((m) => m.status === 'planned'));
});

test('acceptance 4 via CLI: budget exactly equal to demand exits 0', () => {
  const input = toJsonl([
    { type: 'wave', id: 'w1', budget: 14 },
    { type: 'shuttle', id: 's1', battery: 14 },
    { type: 'task', id: 't1', routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 6, duration: 4 }] }] },
    { type: 'task', id: 't2', routes: [{ moves: [{ from: 'C', to: 'D', lane: 'L2', energy: 8, duration: 3 }] }] },
  ]);
  const { exitCode, records } = runCli(['wave'], input);
  assert.equal(exitCode, EXIT.OK);
  assert.equal(records.find((r) => r.type === 'plan').energy, 14);
});

test('wave command exits 17 with the minimal reduction set when budget is insufficient', () => {
  const input = toJsonl([
    { type: 'wave', id: 'w1', budget: 13 },
    { type: 'shuttle', id: 's1', battery: 100 },
    { type: 'task', id: 't1', routes: [{ moves: [{ from: 'A', to: 'B', lane: 'L1', energy: 6, duration: 4 }] }] },
    { type: 'task', id: 't2', routes: [{ moves: [{ from: 'C', to: 'D', lane: 'L2', energy: 8, duration: 3 }] }] },
  ]);
  const { exitCode, records } = runCli(['wave'], input);
  assert.equal(exitCode, EXIT.BUDGET);
  assert.equal(exitCode, 17);
  const err = records.find((r) => r.type === 'error');
  assert.equal(err.code, 'BUDGET_INSUFFICIENT');
  // both single-task cuts are feasible; least removed energy wins (6 < 8)
  assert.deepEqual(err.cut, ['t1']);
  assert.equal(err.removedEnergy, 6);
  assert.equal(err.deficit, 1);
});

test('rollback command cascades and exits 0', () => {
  const wave = runCli(['wave'], WAVE_INPUT);
  const journal = toJsonl([...wave.records, { type: 'status', id: 'w1/t1/0', status: 'done' }]);
  const { exitCode, records } = runCli(['rollback', 'w1'], journal);
  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(records[0], { type: 'rollback', id: 'w1', level: 'wave' });
  assert.equal(records.find((r) => r.type === 'compensation').of, 'w1/t1/0');
  assert.deepEqual(records.find((r) => r.type === 'cancel'), { type: 'cancel', id: 'w1/t2/0', reusable: true });
});

test('level-skipping rollback exits 18', () => {
  const wave = runCli(['wave'], WAVE_INPUT);
  const first = runCli(['rollback', 'w1'], toJsonl(wave.records));
  const journal = toJsonl([...wave.records, ...first.records]);
  const { exitCode, records } = runCli(['rollback', 't1'], journal);
  assert.equal(exitCode, EXIT.LEVEL);
  assert.equal(exitCode, 18);
  assert.equal(records.find((r) => r.type === 'error').code, 'LEVEL_SKIP');
});

test('rollback of unknown target exits 2', () => {
  const { exitCode, records } = runCli(['rollback', 'ghost'], WAVE_INPUT);
  assert.equal(exitCode, EXIT.USAGE);
  assert.equal(records.find((r) => r.type === 'error').code, 'UNKNOWN_TARGET');
});

test('verify command admits causally safe moves and pends conflicts', () => {
  const input = toJsonl([
    { type: 'lane', id: 'L1', state: 'unknown' },
    { type: 'event', id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
    { type: 'event', id: 'x1', shuttle: 's1', op: 'exit', lane: 'L1', of: 'm1' },
    { type: 'event', id: 'm2', shuttle: 's2', op: 'enter', lane: 'L1', after: ['x1'] },
    { type: 'event', id: 'm3', shuttle: 's3', op: 'enter', lane: 'L1' },
  ]);
  const { exitCode, records } = runCli(['verify'], input);
  assert.equal(exitCode, EXIT.OK);
  const byId = Object.fromEntries(records.filter((r) => r.type === 'decision').map((d) => [d.id, d]));
  assert.equal(byId.m3.verdict, 'pending');
  assert.deepEqual(byId.m3.waitFor, ['m1', 'm2']);
  assert.deepEqual(records.find((r) => r.type === 'summary'), { type: 'summary', admitted: 0, pending: 3 });
});

test('verify command admits a fully ordered schedule', () => {
  const input = toJsonl([
    { type: 'event', id: 'm1', shuttle: 's1', op: 'enter', lane: 'L1' },
    { type: 'event', id: 'x1', shuttle: 's1', op: 'exit', lane: 'L1', of: 'm1' },
    { type: 'event', id: 'm2', shuttle: 's2', op: 'enter', lane: 'L1', after: ['x1'] },
  ]);
  const { exitCode, records } = runCli(['verify'], input);
  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(records.find((r) => r.type === 'summary'), { type: 'summary', admitted: 2, pending: 0 });
});

test('invalid JSONL exits 2 with the offending line', () => {
  const { exitCode, records } = runCli(['wave'], '{"type":"wave"}\nnot json');
  assert.equal(exitCode, EXIT.USAGE);
  assert.equal(records[0].code, 'INVALID_JSONL');
  assert.equal(records[0].line, 2);
});

test('missing wave record exits 2', () => {
  const { exitCode, records } = runCli(['wave'], '{"type":"shuttle","id":"s1","battery":5}');
  assert.equal(exitCode, EXIT.USAGE);
  assert.equal(records[0].code, 'INVALID_INPUT');
});

test('unknown command exits 2 with usage on stderr', () => {
  const { exitCode, stderr } = runCli(['frobnicate'], '');
  assert.equal(exitCode, EXIT.USAGE);
  assert.match(stderr, /usage:/);
});
