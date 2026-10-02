import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';

const solveDsl = (text) => {
  const s = new Session();
  s.load(text);
  return s.solve();
};

test('求解：低价时段移峰（电费最小）', () => {
  const r = solveDsl(`
    site A {
      capacity 20 kW
      tariff { price 00:00-02:00 1 price 02:00-04:00 3 }
      template P { power 10 kW duration 60 min window 00:00-04:00 interruptible false }
      task t1 : P
    }
  `);
  assert.equal(r.status, 'FEASIBLE');
  assert.deepEqual(r.schedule[0].slots, [0, 1, 2, 3]);
  assert.equal(r.cost, 10);
});

test('求解：并列最优先取峰值较低', () => {
  // t2 固定在槽 [2,3]；t1 与其重叠则峰值 15，否则 10；各处电费相同
  const r = solveDsl(`
    site A {
      capacity 20 kW
      tariff { price 00:00-24:00 1 }
      template A { power 10 kW duration 30 min window 00:15-02:00 interruptible false }
      template B { power 5 kW duration 30 min window 00:30-01:00 interruptible false }
      task t1 : A
      task t2 : B
    }
  `);
  assert.equal(r.status, 'FEASIBLE');
  assert.equal(r.peak, 10);
  // 峰值并列时再取字典序最小：t1 可选 [4,5] [5,6] [6,7]，取 [4,5]
  assert.deepEqual(r.schedule.find((x) => x.task === 't1').slots, [4, 5]);
});

test('求解：并列最优取任务 ID 字典序较小方案', () => {
  // 容量恰好允许两任务重叠与否均可，字典序最小方案应让 id 小的任务占更早槽
  const r = solveDsl(`
    site A {
      capacity 10 kW
      tariff { price 00:00-24:00 1 }
      template P { power 10 kW duration 30 min window 00:00-01:00 interruptible false }
      task a1 : P
      task a2 : P
    }
  `);
  assert.equal(r.status, 'FEASIBLE');
  assert.deepEqual(r.schedule.find((x) => x.task === 'a1').slots, [0, 1]);
  assert.deepEqual(r.schedule.find((x) => x.task === 'a2').slots, [2, 3]);
});

test('求解：先后关系约束', () => {
  const r = solveDsl(`
    site A {
      capacity 10 kW
      tariff { price 00:00-24:00 1 }
      template P { power 10 kW duration 60 min window 00:00-02:00 interruptible false }
      task t1 : P
      task t2 : P
      order t2 before t1
    }
  `);
  assert.equal(r.status, 'FEASIBLE');
  assert.deepEqual(r.schedule.find((x) => x.task === 't2').slots, [0, 1, 2, 3]);
  assert.deepEqual(r.schedule.find((x) => x.task === 't1').slots, [4, 5, 6, 7]);
});

test('求解：维护窗导致 INFEASIBLE', () => {
  const dsl = (maint) => `
    site A {
      capacity 20 kW
      tariff { price 00:00-24:00 1 }
      ${maint}
      template P { power 10 kW duration 60 min window 08:00-10:00 interruptible false }
      task t1 : P
    }
  `;
  assert.equal(solveDsl(dsl('')).status, 'FEASIBLE');
  assert.equal(solveDsl(dsl('maintenance 08:30-09:30')).status, 'INFEASIBLE');
});

test('求解：可中断任务绕过维护窗', () => {
  const r = solveDsl(`
    site A {
      capacity 20 kW
      tariff { price 00:00-24:00 1 }
      maintenance 08:30-09:30
      template P { power 10 kW duration 60 min window 08:00-10:00 interruptible true maxInterruptions 1 }
      task t1 : P
    }
  `);
  assert.equal(r.status, 'FEASIBLE');
  assert.deepEqual(r.schedule[0].slots, [32, 33, 38, 39]);
});

test('预算：刚好满足为 FEASIBLE，差一单位为 OVER_BUDGET 并报最低成本', () => {
  const dsl = (budget) => `
    site A {
      capacity 20 kW
      tariff { price 00:00-02:00 1 price 02:00-04:00 3 }
      budget { cost ${budget} }
      template P { power 10 kW duration 60 min window 00:00-04:00 interruptible false }
      task t1 : P
    }
  `;
  const ok = solveDsl(dsl(10)); // 最低成本恰为 10
  assert.equal(ok.status, 'FEASIBLE');
  assert.equal(ok.cost, 10);
  const over = solveDsl(dsl(9)); // 差一单位
  assert.equal(over.status, 'OVER_BUDGET');
  assert.equal(over.cost, 10);
  assert.deepEqual(over.exceeded, ['cost']);
});

test('预算：碳排超预算同样 OVER_BUDGET', () => {
  const r = solveDsl(`
    site A {
      capacity 20 kW
      tariff { price 00:00-24:00 1 }
      carbon { intensity 00:00-24:00 1 }
      budget { carbon 9 }
      template P { power 10 kW duration 60 min window 00:00-04:00 interruptible false }
      task t1 : P
    }
  `);
  assert.equal(r.status, 'OVER_BUDGET');
  assert.equal(r.carbon, 10);
  assert.deepEqual(r.exceeded, ['carbon']);
});

test('求解：目标表达式支持加权（minimize cost + peak）', () => {
  const r = solveDsl(`
    site A {
      capacity 20 kW
      tariff { price 00:00-24:00 1 }
      template P { power 10 kW duration 30 min window 00:00-02:00 interruptible false }
      task t1 : P
      minimize cost + peak
    }
  `);
  assert.equal(r.status, 'FEASIBLE');
  assert.equal(r.peak, 10);
});
