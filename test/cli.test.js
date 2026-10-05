import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetSet, cut, measure, writeLog, runCli } from '../support/helpers.js';

test('replay of a clean log exits 0 and reports tool status', () => {
  const log = [...budgetSet({ segment: 100 }), cut('c1', 40)];
  const r = runCli(['replay', writeLog(log)]);
  assert.equal(r.code, 0);
  assert.equal(r.json().tools.T1.status, 'cutting');
});

test('replay reads the log from stdin with -', () => {
  const log = [...budgetSet({ segment: 100 }), cut('c1', 40)];
  const input = log.map((e) => JSON.stringify(e)).join('\n');
  const r = runCli(['replay', '-'], { input });
  assert.equal(r.code, 0);
  assert.equal(r.json().tools.T1.usage, 40);
});

test('budget command prints layered usage and exits 12 when exceeded', () => {
  const ok = runCli(['budget', writeLog([...budgetSet({ order: 1000, operation: 500, segment: 100 }), cut('c1', 50)])]);
  assert.equal(ok.code, 0);
  assert.equal(ok.json().budgets.segment['O1/P1/S1'].usage, 50);
  assert.equal(ok.json().budgets.operation['O1/P1'].usage, 50);
  assert.equal(ok.json().budgets.order.O1.usage, 50);

  const over = runCli(['budget', writeLog([...budgetSet({ segment: 100 }), cut('c1', 101)])]);
  assert.equal(over.code, 12);
  assert.equal(over.json().overspend.event, 'c1');
});

test('audit reports clean log as ok and finds all conflicts', () => {
  const clean = runCli(['audit', writeLog([...budgetSet({ segment: 100 }), cut('c1', 10), measure('m1', 5, ['c1'])])]);
  assert.equal(clean.code, 0);
  assert.equal(clean.json().ok, true);

  const dirty = runCli(['audit', writeLog([
    ...budgetSet({ segment: 100 }),
    cut('c1', 10),
    measure('m1', 5),
    cut('c2', 20),
    measure('m2', 5),
  ])]);
  assert.equal(dirty.code, 14);
  assert.equal(dirty.json().conflicts.length, 6); // C(4,2) concurrent pairs on T1
});

test('audit of an over-budget log exits 12', () => {
  const r = runCli(['audit', writeLog([...budgetSet({ segment: 100 }), cut('c1', 101)])]);
  assert.equal(r.code, 12);
  assert.equal(r.json().overspend.event, 'c1');
});

test('unknown command and missing args exit 2', () => {
  assert.equal(runCli(['frobnicate']).code, 2);
  assert.equal(runCli(['replay']).code, 2);
  assert.equal(runCli([]).code, 2);
});

test('malformed log line exits 2 with VALIDATION error', () => {
  const r = runCli(['replay', writeLog(['{"type":"cut"'])]);
  assert.equal(r.code, 2);
  assert.equal(r.errJson().error.kind, 'VALIDATION');
});
