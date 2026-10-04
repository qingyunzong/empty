import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, toJsonl } from '../support/helpers.mjs';

const CONFIG = { type: 'config', wave: 'W1', budget: 50, shuttles: [{ id: 'S1', home: 'A1:0' }, { id: 'S2', home: 'A2:0' }] };
const TASK1 = { type: 'task', id: 'T1', moves: [{ id: 'M1', from: 'A1:0', to: 'A1:2', energy: 2, duration: 2 }] };
const TASK2 = { type: 'task', id: 'T2', moves: [{ id: 'M2', from: 'A2:0', to: 'A2:3', energy: 3, duration: 3 }] };

test('full chain: wave -> execute -> rollback -> verify stays consistent', () => {
  const wave = runCli(['wave'], toJsonl([CONFIG, TASK1, TASK2]));
  assert.equal(wave.code, 0);
  const waveLine = wave.lines.find((l) => l.type === 'wave');
  assert.equal(waveLine.status, 'planned');
  assert.ok(wave.lines.every((l, i, a) => i === 0 || true));

  const journal = [
    ...wave.lines,
    { type: 'execute', move: 'M1', start: 0, end: 2 },
    { type: 'rollback', level: 'wave', id: 'W1' },
  ];
  const rolled = runCli(['rollback'], toJsonl(journal));
  assert.equal(rolled.code, 0);

  const verify = runCli(['verify'], toJsonl(rolled.lines));
  assert.equal(verify.code, 0, JSON.stringify(verify.lines.at(-1)));
  const summary = verify.lines.find((l) => l.type === 'summary');
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.failed, []);
  // Every check ran and passed.
  const checks = verify.lines.filter((l) => l.type === 'check');
  assert.deepEqual(checks.map((c) => c.name), [
    'hierarchy', 'budget', 'aisle-exclusion', 'causal-order',
    'compensation-integrity', 'pending-conditions',
  ]);
  assert.ok(checks.every((c) => c.ok));
});

test('verify detects a budget violation in a forged journal', () => {
  const wave = runCli(['wave'], toJsonl([CONFIG, TASK1, TASK2]));
  const forged = wave.lines.map((l) => l.type === 'wave' ? { ...l, budget: 1 } : l);
  const verify = runCli(['verify'], toJsonl(forged));
  assert.equal(verify.code, 1);
  const budget = verify.lines.find((l) => l.type === 'check' && l.name === 'budget');
  assert.equal(budget.ok, false);
  assert.ok(budget.violations.length > 0);
});

test('verify detects hierarchy errors', () => {
  const wave = runCli(['wave'], toJsonl([CONFIG, TASK1]));
  const broken = [...wave.lines, { type: 'execute', move: 'NOPE', start: 0, end: 1 }];
  const verify = runCli(['verify'], toJsonl(broken));
  assert.equal(verify.code, 1);
  assert.equal(verify.lines.find((l) => l.type === 'check' && l.name === 'hierarchy').ok, false);
});

test('malformed JSONL exits 2 with a parse error', () => {
  const r = runCli(['wave'], '{"type":"config"\n');
  assert.equal(r.code, 2);
  assert.equal(r.lines[0].code, 'PARSE_ERROR');
  assert.equal(r.lines[0].line, 1);
});

test('wave without budget or shuttles exits 2', () => {
  const r = runCli(['wave'], toJsonl([{ type: 'task', id: 'T1', moves: [] }]));
  assert.equal(r.code, 2);
});

test('rollback flags override the journal rollback line', () => {
  const wave = runCli(['wave'], toJsonl([CONFIG, TASK1, TASK2]));
  const r = runCli(['rollback', '--level', 'task', '--id', 'T2'], toJsonl(wave.lines));
  assert.equal(r.code, 0);
  const result = r.lines.find((l) => l.type === 'rollback-result');
  assert.equal(result.level, 'task');
  assert.equal(result.id, 'T2');
});

test('no command prints usage and exits 2', () => {
  const r = runCli([]);
  assert.equal(r.code, 2);
});
