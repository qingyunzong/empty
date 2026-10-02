import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { bruteForce } from '../src/reference.js';
import { VM } from '../src/vm.js';

// 确定性伪随机数
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSpec(rng, nTasks) {
  const prices = new Array(96).fill(0);
  for (let b = 0; b < 24; b += 1) {
    const p = [0.5, 1, 2][Math.floor(rng() * 3)];
    for (let k = 0; k < 4; k += 1) prices[b * 4 + k] = p;
  }
  const carbonIntensity = new Array(96).fill(0);
  for (let b = 0; b < 24; b += 1) {
    const c = [0.2, 0.5, 0.9][Math.floor(rng() * 3)];
    for (let k = 0; k < 4; k += 1) carbonIntensity[b * 4 + k] = c;
  }
  const tasks = [];
  let totalPower = 0;
  for (let i = 0; i < nTasks; i += 1) {
    const power = 1 + Math.floor(rng() * 5);
    totalPower += power;
    const durationSlots = 1 + Math.floor(rng() * 3);
    const w0 = Math.floor(rng() * 24);
    const extra = Math.floor(rng() * 3); // 窗口余量 0..2 槽，控制组合规模
    const w1 = Math.min(40, w0 + durationSlots + extra);
    const interruptible = rng() < 0.3;
    tasks.push({
      id: `t${i}`,
      power,
      durationSlots,
      window: [w0, Math.max(w1, w0 + durationSlots)],
      interruptible,
      maxInterruptions: interruptible ? 1 : 0,
    });
  }
  const maintenanceSet = new Set();
  if (rng() < 0.3) maintenanceSet.add(Math.floor(rng() * 40));
  const orders = [];
  for (let i = 0; i < nTasks; i += 1) {
    for (let j = i + 1; j < nTasks; j += 1) {
      if (rng() < 0.15) orders.push({ a: `t${i}`, b: `t${j}` });
    }
  }
  const capacity = Math.max(1, Math.ceil(totalPower * (0.4 + rng() * 0.6)));
  return {
    name: 'rnd',
    capacity,
    prices,
    carbonIntensity,
    maintenance: [...maintenanceSet],
    maintenanceSet,
    tasks,
    orders,
    objective: null,
    budgets: { cost: null, carbon: null },
  };
}

function assertSameResult(spec) {
  const fast = solve(spec, new VM());
  const slow = bruteForce(spec);
  assert.equal(fast.status, slow.status, '状态不一致');
  if (fast.status === 'FEASIBLE') {
    assert.ok(Math.abs(fast.cost - slow.cost) < 1e-6, `cost ${fast.cost} != ${slow.cost}`);
    assert.ok(Math.abs(fast.peak - slow.peak) < 1e-6, 'peak 不一致');
    assert.ok(Math.abs(fast.carbon - slow.carbon) < 1e-6, 'carbon 不一致');
    assert.deepEqual(fast.schedule, slow.schedule);
  }
}

test('一致性：随机实例（2-5 任务）与暴力枚举一致', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = mulberry32(seed);
    const nTasks = 2 + Math.floor(rng() * 4);
    assertSameResult(randomSpec(rng, nTasks));
  }
});

test('一致性：8 任务实例与暴力枚举一致', () => {
  for (let seed = 100; seed < 110; seed += 1) {
    const rng = mulberry32(seed);
    assertSameResult(randomSpec(rng, 8));
  }
});
