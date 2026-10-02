import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { runSimulation } from '../src/scheduler.js';

const FLAT = { channels: 1, cooldownPerDegree: 0, agingInterval: 1000 };

function enq(id, project, volume, extra = {}) {
  return { op: 'enqueue', task: { id, project, volume, priority: 0, segments: [{ temp: 37, duration: 5 }] }, ...extra };
}

test('acceptance 3: inter-project round-robin dispatch order is deterministic', () => {
  const config = normalizeConfig(FLAT);
  const ops = [
    { op: 'budget', project: 'P1', set: 1000 },
    { op: 'budget', project: 'P2', set: 1000 },
    enq('A', 'P1', 10),
    enq('B', 'P1', 10),
    enq('C', 'P2', 10),
    enq('D', 'P2', 10),
  ];
  const r1 = runSimulation(new Engine(config), ops);
  const runs = r1.channels[0].events.filter((e) => e.type === 'run');
  assert.deepEqual(runs.map((e) => e.taskId), ['A', 'C', 'B', 'D']);

  const r2 = runSimulation(new Engine(config), ops);
  assert.equal(r1.logRoot, r2.logRoot, 'same ops produce the same log root');
  assert.deepEqual(r1.queue, r2.queue);
});

test('acceptance 3: budget cut from sufficient to insufficient keeps queue order deterministic', () => {
  const config = normalizeConfig(FLAT);
  const ops = [
    { op: 'budget', project: 'P1', set: 100 },
    enq('A', 'P1', 30),
    enq('B', 'P1', 30),
    enq('C', 'P1', 30),
    { op: 'budget', project: 'P1', set: 5 },
    enq('D', 'P1', 30),
  ];
  const engine = new Engine(config);
  const result = runSimulation(engine, ops);
  assert.equal(engine.projects.get('P1').budget, 5);
  const rejected = result.failures.find((f) => f.opIndex === 5);
  assert.equal(rejected.code, 'E_INSUFFICIENT_BUDGET');
  assert.ok(!result.tasks.D, 'deficit project cannot enqueue new tasks');
  assert.deepEqual(
    result.channels[0].events.filter((e) => e.type === 'run').map((e) => e.taskId),
    ['A', 'B', 'C']
  );

  const again = runSimulation(new Engine(config), ops);
  assert.equal(again.logRoot, result.logRoot, 'queue order and charges are reproducible');
});

test('acceptance 3: deficit forbids new tasks but never kills a running critical segment', () => {
  const config = normalizeConfig({ channels: 1, ambientTemp: 25, cooldownPerDegree: 1 });
  const ops = [
    { op: 'budget', project: 'P1', set: 100 },
    {
      op: 'enqueue',
      task: { id: 'LONG', project: 'P1', volume: 90, priority: 0, segments: [{ temp: 37, duration: 50 }] },
    },
    { op: 'budget', project: 'P1', set: 0, at: 5 },
    {
      op: 'enqueue',
      at: 6,
      task: { id: 'X', project: 'P1', volume: 10, priority: 9, segments: [{ temp: 37, duration: 5 }] },
    },
  ];
  const result = runSimulation(new Engine(config), ops);
  assert.equal(result.tasks.LONG.status, 'completed', 'running segment is not force-terminated');
  assert.equal(result.tasks.LONG.completedAt, 62);
  assert.ok(!result.tasks.X, 'deficit blocks the new task');
  assert.equal(result.failures.find((f) => f.opIndex === 3).code, 'E_INSUFFICIENT_BUDGET');
});
