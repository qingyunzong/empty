import { test } from 'node:test';
import { equal, deepEqual, throws, ok } from 'node:assert/strict';
import { allocate, Allocator } from '../src/allocator.ts';
import { unitModelAllocate } from '../src/unit-model.ts';
import { compareWithUnitModel } from '../src/compare.ts';
import { Rat } from '../src/rational.ts';
import type { UserInput } from '../src/allocator.ts';

test('加权最大最小公平:权重 1:3,饱和轮次与分数证据', () => {
  const res = allocate(10, [
    { id: 'A', demand: 6, weight: 1, cap: 6 },
    { id: 'B', demand: 6, weight: 3, cap: 6 },
  ]);
  deepEqual(res.allocation, { A: 4, B: 6 });
  deepEqual(res.fractional, { A: '4', B: '6' });
  equal(res.rounds.length, 2);
  equal(res.rounds[0].level, '2');
  deepEqual(res.rounds[0].saturatedIds, ['B']);
  equal(res.rounds[0].capacityRemaining, '2');
  equal(res.rounds[1].level, '4');
  deepEqual(res.rounds[1].saturatedIds, []);
  equal(res.rounds[1].capacityRemaining, '0');
  deepEqual(res.saturationRound, { B: 1 });
  equal(res.allocatedTotal, 10);
  equal(res.unservedCapacity, 0);
});

test('余数按 ID 顺序补分', () => {
  const res = allocate(5, [
    { id: 'A', demand: 10, weight: 1, cap: 10 },
    { id: 'B', demand: 10, weight: 1, cap: 10 },
    { id: 'C', demand: 10, weight: 1, cap: 10 },
  ]);
  deepEqual(res.fractional, { A: '5/3', B: '5/3', C: '5/3' });
  deepEqual(res.allocation, { A: 2, B: 2, C: 1 });
  deepEqual(res.remainderRecipients, ['A', 'B']);
  equal(res.rounds.length, 1);
  equal(res.rounds[0].level, '5/3');
});

test('每户上限优先于需求生效', () => {
  const res = allocate(10, [
    { id: 'A', demand: 100, weight: 1, cap: 3 },
    { id: 'B', demand: 100, weight: 1, cap: 100 },
  ]);
  deepEqual(res.allocation, { A: 3, B: 7 });
  deepEqual(res.saturatedIds, ['A']);
  deepEqual(res.saturationRound, { A: 1 });
  equal(res.rounds.length, 2);
});

test('容量充足时全部满足并报告未服务容量', () => {
  const res = allocate(100, [
    { id: 'A', demand: 10, weight: 1, cap: 10 },
    { id: 'B', demand: 20, weight: 2, cap: 20 },
  ]);
  deepEqual(res.allocation, { A: 10, B: 20 });
  equal(res.allocatedTotal, 30);
  equal(res.unservedCapacity, 70);
  equal(res.rounds.length, 1);
  deepEqual(res.saturatedIds, ['A', 'B']);
});

test('多轮饱和:逐轮水位、饱和用户与余数证据', () => {
  const users: UserInput[] = [
    { id: 'alpha', demand: 5, weight: 1, cap: 10 },
    { id: 'beta', demand: 50, weight: 1, cap: 60 },
    { id: 'gamma', demand: 1000, weight: 1, cap: 1000 },
  ];
  const res = allocate(100, users);
  equal(res.rounds.length, 2);
  equal(res.rounds[0].level, '5');
  deepEqual(res.rounds[0].saturatedIds, ['alpha']);
  equal(res.rounds[0].capacityRemaining, '85');
  equal(res.rounds[1].level, '95/2');
  equal(res.rounds[1].capacityRemaining, '0');
  deepEqual(res.saturationRound, { alpha: 1 });
  deepEqual(res.fractional, { alpha: '5', beta: '95/2', gamma: '95/2' });
  deepEqual(res.allocation, { alpha: 5, beta: 48, gamma: 47 });
  deepEqual(res.remainderRecipients, ['beta']);
});

test('分数权重(0.5 : 1.5)精确分摊', () => {
  const res = allocate(4, [
    { id: 'A', demand: 100, weight: 0.5, cap: 100 },
    { id: 'B', demand: 100, weight: 1.5, cap: 100 },
  ]);
  deepEqual(res.allocation, { A: 1, B: 3 });
  deepEqual(res.fractional, { A: '1', B: '3' });
});

test('需求撤销后重新分摊', () => {
  const allocator = new Allocator(10);
  allocator.addUser({ id: 'A', demand: 4, weight: 1, cap: 4 });
  allocator.addUser({ id: 'B', demand: 4, weight: 1, cap: 4 });
  allocator.addUser({ id: 'C', demand: 100, weight: 1, cap: 100 });

  const first = allocator.allocate();
  deepEqual(first.allocation, { A: 4, B: 3, C: 3 });
  deepEqual(first.fractional, { A: '10/3', B: '10/3', C: '10/3' });

  equal(allocator.revoke('A'), true);
  equal(allocator.revoke('nobody'), false);

  const second = allocator.allocate();
  deepEqual(second.allocation, { B: 4, C: 6 });
  deepEqual(second.saturatedIds, ['B']);
  deepEqual(second.saturationRound, { B: 1 });
  equal(second.allocatedTotal, 10);
});

test('非法输入一律拒绝', () => {
  throws(() => allocate(-1, []), /capacity/);
  throws(() => allocate(1.5, []), /capacity/);
  throws(
    () => allocate(1, [{ id: 'A', demand: -1, weight: 1, cap: 1 }]),
    /demand/,
  );
  throws(
    () => allocate(1, [{ id: 'A', demand: 1, weight: 0, cap: 1 }]),
    /weight/,
  );
  throws(
    () => allocate(1, [{ id: 'A', demand: 1, weight: 1, cap: -2 }]),
    /cap/,
  );
  throws(
    () =>
      allocate(1, [
        { id: 'A', demand: 1, weight: 1, cap: 1 },
        { id: 'A', demand: 1, weight: 1, cap: 1 },
      ]),
    /重复/,
  );
});

test('逐单位小容量模型对照:固定案例完全一致', () => {
  const users: UserInput[] = [
    { id: 'alpha', demand: 5, weight: 1, cap: 10 },
    { id: 'beta', demand: 50, weight: 1, cap: 60 },
    { id: 'gamma', demand: 1000, weight: 1, cap: 1000 },
  ];
  const res = allocate(100, users);
  const unit = unitModelAllocate(100, users);
  deepEqual(res.allocation, unit);

  const report = compareWithUnitModel(100, users, res);
  equal(report.maxAbsDiff, 0);
  equal(report.roundModelTotal, 100);
  equal(report.unitModelTotal, 100);
});

test('逐单位小容量模型对照:加权案例完全一致', () => {
  const users: UserInput[] = [
    { id: 'A', demand: 6, weight: 1, cap: 6 },
    { id: 'B', demand: 6, weight: 3, cap: 6 },
  ];
  deepEqual(allocate(10, users).allocation, unitModelAllocate(10, users));
});

test('分摊结果确定性:同一输入两次结果相同', () => {
  const users: UserInput[] = [
    { id: 'x', demand: 7, weight: 2, cap: 9 },
    { id: 'y', demand: 3, weight: 1, cap: 3 },
    { id: 'z', demand: 11, weight: 5, cap: 20 },
  ];
  deepEqual(allocate(23, users), allocate(23, users));
});

// 确定性伪随机数,保证测试可复现
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('随机场景属性:守恒、上限、与逐单位模型偏差 <= 1', () => {
  const rand = mulberry32(20261005);
  for (let iter = 0; iter < 100; iter += 1) {
    const userCount = 1 + Math.floor(rand() * 8);
    const users: UserInput[] = [];
    for (let k = 0; k < userCount; k += 1) {
      users.push({
        id: `u${k}`,
        demand: Math.floor(rand() * 31),
        weight: 1 + Math.floor(rand() * 5),
        cap: Math.floor(rand() * 36),
      });
    }
    const capacity = Math.floor(rand() * 81);
    const res = allocate(capacity, users);
    const totalEffective = users.reduce((acc, u) => acc + Math.min(u.demand, u.cap), 0);
    const expected = Math.min(capacity, totalEffective);

    // 守恒:整数分配总量 == min(容量, 总有效需求)
    equal(res.allocatedTotal, expected, `iter ${iter}: 整数分配不守恒`);
    equal(res.unservedCapacity, capacity - expected, `iter ${iter}: 未服务容量错误`);

    // 分数应得之和同样守恒
    let fracSum = Rat.zero();
    for (const u of users) fracSum = fracSum.add(Rat.of(res.fractional[u.id]));
    equal(fracSum.toString(), String(expected), `iter ${iter}: 分数应得不守恒`);

    // 每户不超有效需求
    for (const u of users) {
      const eff = Math.min(u.demand, u.cap);
      ok(res.allocation[u.id] >= 0 && res.allocation[u.id] <= eff, `iter ${iter}: ${u.id} 越界`);
    }

    // 水位逐轮单调不减
    for (let r = 1; r < res.rounds.length; r += 1) {
      ok(
        res.rounds[r].levelValue >= res.rounds[r - 1].levelValue,
        `iter ${iter}: 水位回退`,
      );
    }

    // 与逐单位小容量模型对照
    const report = compareWithUnitModel(capacity, users, res);
    equal(report.roundModelTotal, expected, `iter ${iter}: 逐轮总量错误`);
    equal(report.unitModelTotal, expected, `iter ${iter}: 逐单位总量错误`);
    ok(report.maxAbsDiff <= 1, `iter ${iter}: 两模型偏差 ${report.maxAbsDiff} > 1`);
  }
});
