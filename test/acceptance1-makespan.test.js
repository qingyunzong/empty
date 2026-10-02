import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { runSimulation } from '../src/scheduler.js';
import { mulberry32, bruteForceMakespan } from './helpers.js';

const TEMPS = [4, 16, 25, 37, 56, 70];

function randomCase(rand, n, channels) {
  const config = normalizeConfig({
    channels,
    cooldownPerDegree: [0.5, 1, 2][Math.floor(rand() * 3)],
    ambientTemp: 25,
    maxTempJump: 100,
    exactThreshold: 8,
  });
  const tasks = [];
  const ops = [{ op: 'budget', project: 'PROJ', set: 1e9 }];
  for (let i = 0; i < n; i++) {
    const segCount = 1 + Math.floor(rand() * 3);
    const segments = [];
    for (let s = 0; s < segCount; s++) {
      segments.push({
        temp: TEMPS[Math.floor(rand() * TEMPS.length)],
        duration: 1 + Math.floor(rand() * 9),
      });
    }
    const task = { id: `T${i}`, project: 'PROJ', volume: 1, priority: 0, segments };
    tasks.push({ segments });
    ops.push({ op: 'enqueue', task });
  }
  return { config, tasks, ops };
}

test('acceptance 1: scheduler matches exhaustive minimum makespan for n<=8', () => {
  const rand = mulberry32(20261003);
  let checked = 0;
  for (let trial = 0; trial < 26; trial++) {
    const channels = trial < 20 ? 1 + Math.floor(rand() * 2) : 3;
    const n = channels === 3 ? 4 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 8);
    const { config, tasks, ops } = randomCase(rand, n, channels);
    const engine = new Engine(config);
    const result = runSimulation(engine, ops);
    const optimal = bruteForceMakespan(
      tasks,
      Array.from({ length: channels }, () => config.ambientTemp),
      config
    );
    assert.equal(
      result.makespan,
      optimal,
      `trial ${trial}: n=${n} channels=${channels} makespan ${result.makespan} != optimal ${optimal}`
    );
    for (const [id, t] of Object.entries(result.tasks)) {
      assert.equal(t.status, 'completed', `${id} should complete`);
    }
    checked++;
  }
  assert.equal(checked, 26);
});

test('acceptance 1: exact batch planning is deterministic', () => {
  const rand = mulberry32(7);
  const { config, ops } = randomCase(rand, 8, 2);
  const a = runSimulation(new Engine(config), ops);
  const b = runSimulation(new Engine(config), ops);
  assert.equal(a.logRoot, b.logRoot);
  assert.deepEqual(a.channels, b.channels);
});
