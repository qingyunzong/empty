"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../src/engine");
const { optimalMakespan } = require("../src/enumerate");

const CFG = { channels: 2, initialTemp: 20, cooldown: 5 };

function runEngine(tasks, config = CFG) {
  const e = new Engine(config);
  tasks.forEach((t, i) => {
    e.applyOp({
      op: "enqueue",
      time: 0,
      task: {
        id: "t" + i,
        project: "P1",
        volume: 10,
        priority: 1,
        segments: t.segments,
      },
    });
  });
  e.finish();
  return e.getOutput().makespan;
}

function segs(temp, duration) {
  return [{ temp, duration }];
}

test("acceptance 1a: equal tasks on two channels match enumerated optimum", () => {
  const tasks = [0, 1, 2, 3].map(() => ({ segments: segs(20, 4) }));
  const optimal = optimalMakespan(tasks, 2, CFG);
  assert.equal(optimal, 8);
  assert.equal(runEngine(tasks), optimal);
});

test("acceptance 1b: single channel with temperature switches matches optimum", () => {
  const cfg = { channels: 1, initialTemp: 20, cooldown: 5 };
  const tasks = [
    { segments: segs(20, 5) },
    { segments: segs(20, 5) },
    { segments: segs(37, 5) },
  ];
  const optimal = optimalMakespan(tasks, 1, cfg);
  assert.equal(optimal, 20); // 5+5 + 5 cooldown + 5
  assert.equal(runEngine(tasks, cfg), optimal);
});

test("acceptance 1c: mixed temperatures on two channels match optimum", () => {
  const tasks = [
    { segments: segs(20, 6) },
    { segments: segs(20, 6) },
    { segments: segs(37, 6) },
    { segments: segs(37, 6) },
  ];
  const optimal = optimalMakespan(tasks, 2, CFG);
  assert.equal(optimal, 17);
  assert.equal(runEngine(tasks), optimal);
});

test("acceptance 1d: multi-segment tasks, scheduler never beats the optimum", () => {
  // Deterministic PRNG so the cross-check is reproducible.
  let seed = 42;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let iter = 0; iter < 10; iter++) {
    const n = 4 + Math.floor(rand() * 3); // 4..6 tasks
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const temp = rand() < 0.5 ? 20 : 37;
      const duration = 1 + Math.floor(rand() * 6);
      tasks.push({ segments: segs(temp, duration) });
    }
    const optimal = optimalMakespan(tasks, 2, CFG);
    const got = runEngine(tasks);
    assert.ok(got >= optimal, `iter ${iter}: scheduler ${got} < optimal ${optimal}`);
  }
});
