import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { runSimulation } from '../src/scheduler.js';

function scenario() {
  const config = normalizeConfig({
    channels: 1,
    ambientTemp: 25,
    cooldownPerDegree: 1,
    agingInterval: 10,
  });
  const ops = [
    { op: 'budget', project: 'P', set: 1000 },
    {
      op: 'enqueue',
      task: {
        id: 'LOW',
        project: 'P',
        volume: 1,
        priority: 1,
        segments: [
          { temp: 37, duration: 10 },
          { temp: 37, duration: 10 },
        ],
      },
    },
    {
      op: 'enqueue',
      at: 3,
      task: { id: 'HIGH', project: 'P', volume: 1, priority: 5, segments: [{ temp: 37, duration: 6 }] },
    },
  ];
  return { config, ops };
}

test('acceptance 2: high priority preempts low priority at segment boundary and resumes', () => {
  const { config, ops } = scenario();
  const engine = new Engine(config);
  const result = runSimulation(engine, ops);

  const events = result.channels[0].events.filter((e) => e.type !== 'idle');
  assert.deepEqual(
    events.map((e) => [e.type, e.taskId ?? null, e.segment ?? null, e.start, e.end]),
    [
      ['cooldown', 'LOW', null, 0, 12],
      ['run', 'LOW', 0, 12, 22],
      ['run', 'HIGH', 0, 22, 28],
      ['run', 'LOW', 1, 28, 38],
    ]
  );
  assert.equal(result.makespan, 38);
  assert.equal(result.tasks.LOW.status, 'completed');
  assert.equal(result.tasks.LOW.segmentsCompleted, 2);
  assert.equal(result.tasks.HIGH.status, 'completed');

  const preempt = engine.log.entries.find((e) => e.type === 'preempt');
  assert.ok(preempt, 'preempt event logged');
  assert.equal(preempt.data.taskId, 'LOW');
  assert.equal(preempt.data.by, 'HIGH');
  assert.equal(preempt.data.time, 22);
  assert.equal(preempt.data.resumeSegment, 1, 'progress saved at the segment boundary');
});

test('acceptance 2: no preemption without a higher effective priority', () => {
  const { config } = scenario();
  const ops = [
    { op: 'budget', project: 'P', set: 1000 },
    {
      op: 'enqueue',
      task: {
        id: 'LOW',
        project: 'P',
        volume: 1,
        priority: 5,
        segments: [
          { temp: 37, duration: 10 },
          { temp: 37, duration: 10 },
        ],
      },
    },
    {
      op: 'enqueue',
      at: 3,
      task: { id: 'PEER', project: 'P', volume: 1, priority: 5, segments: [{ temp: 37, duration: 6 }] },
    },
  ];
  const result = runSimulation(new Engine(config), ops);
  const runs = result.channels[0].events.filter((e) => e.type === 'run');
  assert.deepEqual(
    runs.map((e) => [e.taskId, e.segment]),
    [
      ['LOW', 0],
      ['LOW', 1],
      ['PEER', 0],
    ]
  );
});
