import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule } from '../src/scheduler.js';
import { bruteForceSchedule, makeMold, maintEvents, orderEvents, mulberry32 } from '../testlib/helpers.js';

test('寿命充足时直接加工，跳过班次间隙', () => {
  const mold = makeMold({
    cycleMinutes: 1000,
    calendar: [{ start: 0, end: 60 }, { start: 120, end: 240 }],
  });
  const s = computeSchedule(mold, [{ id: 'O1', durationMinutes: 90 }]);
  assert.deepEqual(orderEvents(s), [{ type: 'order', moldId: 'M1', orderId: 'O1', start: 0, end: 150 }]);
  assert.equal(maintEvents(s).length, 0);
  assert.equal(s.usedFinal, 90);
});

test('加工后超过寿命上限时先插入保养', () => {
  const mold = makeMold({ usedMinutes: 90 });
  const s = computeSchedule(mold, [{ id: 'O1', durationMinutes: 50 }]);
  assert.deepEqual(maintEvents(s), [{ type: 'maintenance', moldId: 'M1', start: 0, end: 20 }]);
  assert.deepEqual(orderEvents(s).map((e) => [e.start, e.end]), [[20, 70]]);
  assert.equal(s.usedFinal, 50);
});

test('单工单长于一个寿命周期时插入多次保养', () => {
  const mold = makeMold({ cycleMinutes: 100, maintenanceMinutes: 10 });
  const s = computeSchedule(mold, [{ id: 'O1', durationMinutes: 250 }]);
  assert.equal(maintEvents(s).length, 2);
  assert.equal(orderEvents(s)[0].end, 270);
  assert.equal(s.usedFinal, 50);
});

test('强制重置区间归零寿命，避免不必要保养', () => {
  const mold = makeMold({
    cycleMinutes: 100,
    maintenanceMinutes: 20,
    usedMinutes: 90,
    calendar: [{ start: 0, end: 1000 }],
    resetIntervals: [{ start: 200, end: 300 }],
  });
  const s = computeSchedule(mold, [
    { id: 'O1', durationMinutes: 150 },
    { id: 'O2', durationMinutes: 80 },
  ]);
  // O1 需要两次保养（90+150 超限，且重置在保养完成之后）；O2 由重置救下，无需保养。
  assert.equal(maintEvents(s).length, 2);
  const [o1, o2] = orderEvents(s);
  assert.equal(o1.end, 190);
  assert.equal(o2.start, 190);
  assert.equal(o2.end, 370); // 190→200 加工 10 分钟，跨过重置 [200,300)，再加工 70 分钟
  assert.equal(s.usedFinal, 70);
});

test('强制重置比保养更早到来时等待重置而非保养', () => {
  const mold = makeMold({
    cycleMinutes: 100,
    maintenanceMinutes: 20,
    usedMinutes: 95,
    calendar: [{ start: 0, end: 1000 }],
    resetIntervals: [{ start: 10, end: 50 }],
  });
  const s = computeSchedule(mold, [{ id: 'O1', durationMinutes: 50 }]);
  assert.equal(maintEvents(s).length, 0);
  assert.deepEqual(orderEvents(s).map((e) => [e.start, e.end]), [[50, 100]]);
});

test('日历不足时报错', () => {
  const mold = makeMold({ calendar: [{ start: 0, end: 30 }] });
  assert.throws(() => computeSchedule(mold, [{ id: 'O1', durationMinutes: 60 }]), /insufficient calendar/);
});

test('随机小规模用例与暴力枚举对照（保养次数与完工时间一致）', () => {
  const rand = mulberry32(20261003);
  const pick = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  for (let iter = 0; iter < 300; iter += 1) {
    const cycle = pick(60, 240);
    const maint = pick(10, 50);
    const used0 = pick(0, cycle);
    const windows = [];
    let t = 0;
    const wn = pick(2, 5);
    for (let i = 0; i < wn; i += 1) {
      const len = pick(60, 400);
      windows.push({ start: t, end: t + len });
      t += len + pick(0, 300);
    }
    windows.push({ start: t, end: t + 100000 }); // 保证日历充足
    const n = pick(1, 6);
    const orders = Array.from({ length: n }, (_, i) => ({
      id: `O${i + 1}`,
      durationMinutes: pick(10, cycle),
    }));
    const mold = makeMold({
      id: 'MX',
      cycleMinutes: cycle,
      maintenanceMinutes: maint,
      usedMinutes: used0,
      calendar: windows,
    });
    const lib = computeSchedule(mold, orders);
    const brute = bruteForceSchedule(mold, orders);
    assert.ok(brute, `case ${iter}: brute force found no feasible plan`);
    assert.equal(maintEvents(lib).length, brute.maintenances, `case ${iter}: maintenance count`);
    assert.equal(lib.end, brute.end, `case ${iter}: makespan`);
  }
});
