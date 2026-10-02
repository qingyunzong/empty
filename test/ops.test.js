import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { Engine, exitCodeFor } from '../src/engine.js';
import { runSimulation } from '../src/scheduler.js';

function engineWith(overrides = {}) {
  return new Engine(normalizeConfig(overrides));
}

function task(id, volume, segments = [{ temp: 37, duration: 5 }]) {
  return { id, project: 'P', volume, priority: 0, segments };
}

test('volume exceeding the plate is rejected', () => {
  const e = engineWith();
  e.applyOp({ op: 'budget', project: 'P', set: 1e9 }, 0);
  const code = e.applyOp({ op: 'enqueue', task: task('BIG', 5000) }, 1);
  assert.equal(code, 'E_VOLUME_EXCEEDS_PLATE');
  assert.equal(exitCodeFor(e.failures), 5);
});

test('temperature jump beyond ramp capability is a cooldown conflict', () => {
  const e = engineWith({ maxTempJump: 60 });
  e.applyOp({ op: 'budget', project: 'P', set: 1e9 }, 0);
  const code = e.applyOp(
    { op: 'enqueue', task: task('JUMP', 1, [{ temp: 4, duration: 5 }, { temp: 80, duration: 5 }]) },
    1
  );
  assert.equal(code, 'E_COOLDOWN_CONFLICT');
  assert.equal(exitCodeFor(e.failures), 5);
});

test('negative budget is rejected', () => {
  const e = engineWith();
  const code = e.applyOp({ op: 'budget', project: 'P', set: -5 }, 0);
  assert.equal(code, 'E_BUDGET_NEGATIVE');
  assert.equal(exitCodeFor(e.failures), 5);
});

test('correct changes volume and recomputes feasibility', () => {
  const e = engineWith();
  e.applyOp({ op: 'budget', project: 'P', set: 100 }, 0);
  e.applyOp({ op: 'enqueue', task: task('T', 10) }, 1);
  assert.equal(e.projects.get('P').budget, 90);

  assert.equal(e.applyOp({ op: 'correct', taskId: 'T', volume: 20 }, 2), null);
  assert.equal(e.projects.get('P').budget, 80, 'delta charged on correction');

  assert.equal(e.applyOp({ op: 'correct', taskId: 'T', volume: 5000 }, 3), 'E_VOLUME_EXCEEDS_PLATE');
  assert.equal(e.tasks.get('T').volume, 20, 'failed correction leaves state unchanged');

  e.applyOp({ op: 'budget', project: 'P', set: 25 }, 4);
  assert.equal(e.applyOp({ op: 'correct', taskId: 'T', volume: 40 }, 5), null, 'delta 20 fits budget 25');
  assert.equal(e.projects.get('P').budget, 5);
  assert.equal(e.applyOp({ op: 'correct', taskId: 'T', volume: 50 }, 6), 'E_BUDGET_NEGATIVE');
});

test('undo rolls back the operation stack in LIFO order', () => {
  const e = engineWith();
  e.applyOp({ op: 'budget', project: 'P', set: 100 }, 0);
  e.applyOp({ op: 'enqueue', task: task('T', 10) }, 1);
  e.applyOp({ op: 'correct', taskId: 'T', volume: 20 }, 2);
  assert.equal(e.projects.get('P').budget, 80);

  assert.equal(e.applyOp({ op: 'undo' }, 3), null, 'undo correct');
  assert.equal(e.tasks.get('T').volume, 10);
  assert.equal(e.projects.get('P').budget, 90);

  assert.equal(e.applyOp({ op: 'undo' }, 4), null, 'undo enqueue');
  assert.ok(!e.tasks.has('T'));
  assert.equal(e.projects.get('P').budget, 100, 'charge refunded');

  assert.equal(e.applyOp({ op: 'undo' }, 5), null, 'undo budget');
  assert.equal(e.projects.get('P').budget, 0);

  assert.equal(e.applyOp({ op: 'undo' }, 6), 'E_NO_UNDO');
});

test('undo cannot resurrect confirmed contaminated wells', () => {
  const e = engineWith();
  e.applyOp({ op: 'budget', project: 'P', set: 1e9 }, 0);
  e.applyOp({ op: 'enqueue', task: task('T', 10) }, 1);
  assert.equal(e.applyOp({ op: 'abort', taskId: 'T' }, 2), null);
  assert.equal(e.contaminatedWells, 1);

  assert.equal(e.applyOp({ op: 'undo' }, 3), 'E_CONTAMINATED_REVIVE');
  assert.equal(e.tasks.get('T').status, 'aborted', 'aborted task stays dead');

  assert.equal(e.applyOp({ op: 'enqueue', task: task('W', 3830) }, 4), null, '383 wells still fit');
  assert.equal(
    e.applyOp({ op: 'enqueue', task: task('Z', 10) }, 5),
    'E_VOLUME_EXCEEDS_PLATE',
    'contaminated well reduces plate capacity'
  );
});

test('abort of a running task truncates the current segment', () => {
  const e = engineWith({ channels: 1, ambientTemp: 37, cooldownPerDegree: 0 });
  const ops = [
    { op: 'budget', project: 'P', set: 100 },
    { op: 'enqueue', task: task('RUN', 10, [{ temp: 37, duration: 100 }]) },
    { op: 'abort', taskId: 'RUN', at: 20 },
  ];
  const result = runSimulation(e, ops);
  assert.equal(result.tasks.RUN.status, 'aborted');
  const run = result.channels[0].events.find((ev) => ev.type === 'run');
  assert.equal(run.end, 20, 'segment truncated at abort time');
  assert.equal(result.makespan, 20);
  assert.equal(e.contaminatedWells, 1);
});
