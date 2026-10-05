import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/replay.js';
import { ReplayError } from '../src/errors.js';
import { budgetSet, cut, writeLog, runCli } from '../support/helpers.js';

const tr = (id, to, causes = [], tool = 'T1') => ({ type: 'transition', id, tool, to, causes });

test('legal transition chain idle->cutting->worn->locked', () => {
  const r = replay([
    ...budgetSet({ segment: 1000 }),
    cut('c1', 10),
    tr('t1', 'idle', ['c1']),
    tr('t2', 'cutting', ['t1']),
    tr('t3', 'worn', ['t2']),
    tr('t4', 'locked', ['t3']),
  ]);
  assert.equal(r.tools.T1.status, 'locked');
  assert.equal(r.exitCode, 0);
});

test('illegal transition locked->idle exits 13', () => {
  const log = [...budgetSet({ segment: 10 }), cut('c1', 11), tr('t1', 'idle', ['c1'])];
  assert.throws(() => replay(log), (e) => e instanceof ReplayError && e.kind === 'ILLEGAL_TRANSITION');
  const file = writeLog(log);
  const r = runCli(['replay', file]);
  assert.equal(r.code, 13);
  assert.equal(r.errJson().error.kind, 'ILLEGAL_TRANSITION');
});

test('illegal skip idle->worn exits 13', () => {
  const log = [...budgetSet({ segment: 10 }), tr('t1', 'worn')];
  const r = runCli(['replay', writeLog(log)]);
  assert.equal(r.code, 13);
  assert.match(r.errJson().error.message, /idle -> worn/);
});

test('causal guard: transition not caused by current state token exits 13', () => {
  const log = [
    ...budgetSet({ segment: 1000 }),
    cut('c1', 10),
    tr('t1', 'idle'), // concurrent with c1: guard fails
  ];
  assert.throws(() => replay(log), /causal guard failed/);
  const r = runCli(['replay', writeLog(log)]);
  assert.equal(r.code, 13);
});

test('transition caused through an intermediate event passes the guard', () => {
  const log = [
    ...budgetSet({ segment: 1000 }),
    cut('c1', 10),
    tr('t1', 'idle', ['c1']),
    cut('c2', 5, ['t1']),
    tr('t2', 'idle', ['c2']),
  ];
  const r = replay(log);
  assert.equal(r.tools.T1.status, 'idle');
});
