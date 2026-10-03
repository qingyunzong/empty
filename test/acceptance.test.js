import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolingSystem } from '../src/system.js';
import { JsonStore } from '../src/store.js';
import { bruteForceSchedule, maintEvents, orderEvents } from '../testlib/helpers.js';

test('验收1：两套模具触发不同保养且并列进行', () => {
  const sys = new ToolingSystem();
  // 两套模具同一班次日历、不同保养时长，寿命都已接近上限
  sys.command({
    cmd: 'addMold', id: 'M1', cycleMinutes: 100, maintenanceMinutes: 20,
    usedMinutes: 90, calendar: [{ start: 0, end: 100000 }],
  });
  sys.command({
    cmd: 'addMold', id: 'M2', cycleMinutes: 100, maintenanceMinutes: 30,
    usedMinutes: 95, calendar: [{ start: 0, end: 100000 }],
  });
  const r1 = sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 50, moldId: 'M1' });
  const r2 = sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 50, moldId: 'M2' });
  // 两套模具各自触发不同的保养
  assert.deepEqual(r1.maintenances, [{ start: 0, end: 20 }]);
  assert.deepEqual(r2.maintenances, [{ start: 0, end: 30 }]);
  // 保养并列：不同模具的保养区间在时间上重叠（不重叠约束仅作用于同一模具）
  const [m1] = r1.maintenances;
  const [m2] = r2.maintenances;
  assert.ok(m1.start < m2.end && m2.start < m1.end, '两模具保养时间并列');
  // 工单在各自保养之后加工
  assert.deepEqual([r1.start, r1.end], [20, 70]);
  assert.deepEqual([r2.start, r2.end], [30, 80]);
  const sched = sys.schedule();
  assert.equal(maintEvents(sched.M1).length + maintEvents(sched.M2).length, 2);
});

test('验收2：保养遇休息日延迟，工单顺序保持不变', () => {
  const sys = new ToolingSystem();
  // 班次：第1天 [0,480)，休息 [480,1440)，第2天 [1440,1920)，第3天 [2880,3360)
  sys.command({
    cmd: 'addMold', id: 'M1', cycleMinutes: 500, maintenanceMinutes: 100,
    usedMinutes: 0,
    calendar: [
      { start: 0, end: 480 },
      { start: 1440, end: 1920 },
      { start: 2880, end: 3360 },
    ],
  });
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 450, moldId: 'M1' });
  sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 100, moldId: 'M1' });
  sys.command({ cmd: 'reserve', orderId: 'O3', durationMinutes: 50, moldId: 'M1' });
  const sched = sys.schedule().M1;
  const [maint] = maintEvents(sched);
  // 保养从第1天 450 开始，只做 30 分钟即遇休息日，延迟到第2天继续，1510 才完成
  assert.deepEqual([maint.start, maint.end], [450, 1510]);
  assert.ok(maint.end > 1440, '保养被休息日延迟到次日班次');
  assert.equal(maint.end - maint.start, 100 + (1440 - 480), '保养实际工时 100 分钟，其余为休息');
  const orders = orderEvents(sched);
  // 工单顺序保持 O1 → O2 → O3，且没有任何加工落在休息日 [480,1440)
  assert.deepEqual(orders.map((e) => e.orderId), ['O1', 'O2', 'O3']);
  assert.deepEqual([orders[0].start, orders[0].end], [0, 450]);
  assert.deepEqual([orders[1].start, orders[1].end], [1510, 1610]);
  assert.deepEqual([orders[2].start, orders[2].end], [1610, 1660]);
  for (const e of orders) {
    assert.ok(e.end <= 480 || e.start >= 1440, `工单 ${e.orderId} 不占用休息日`);
  }
});

test('验收3：rename 前故障后恢复，并与枚举保养位置的暴力算法对照', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-acceptance-'));
  const file = path.join(dir, 'state.json');
  let crash = false;
  const store = new JsonStore(file, {
    beforeRename: () => { if (crash) throw new Error('simulated crash before rename'); },
  });
  const mold = {
    id: 'M1', cycleMinutes: 120, maintenanceMinutes: 30, usedMinutes: 50,
    calendar: [{ start: 0, end: 480 }, { start: 1440, end: 1920 }, { start: 2880, end: 100000 }],
    resetIntervals: [],
  };
  const sys = new ToolingSystem();
  sys.command({ cmd: 'addMold', ...mold });
  store.commit(sys.state);
  const baselineRaw = fs.readFileSync(file, 'utf8');

  // 推进三笔工单事务，但提交时在 rename 前崩溃
  sys.command({ cmd: 'reserve', orderId: 'O1', durationMinutes: 80 });
  sys.command({ cmd: 'reserve', orderId: 'O2', durationMinutes: 90 });
  sys.command({ cmd: 'reserve', orderId: 'O3', durationMinutes: 60 });
  crash = true;
  assert.throws(() => store.commit(sys.state), /simulated crash before rename/);
  // 旧文件仍可打开，无半笔事务（O1~O3 均未落盘）
  assert.equal(fs.readFileSync(file, 'utf8'), baselineRaw);
  assert.deepEqual(Object.keys(new ToolingSystem(store.load()).state.orders), []);

  // 恢复：故障解除后重新提交，全部事务原子生效
  crash = false;
  store.commit(sys.state);
  const recovered = new ToolingSystem(store.load());
  assert.deepEqual(Object.keys(recovered.state.orders).sort(), ['O1', 'O2', 'O3']);

  // 用枚举保养位置的小规模暴力算法对照恢复后的调度
  const sched = recovered.schedule().M1;
  const orders = ['O1', 'O2', 'O3'].map((id) => recovered.state.orders[id]);
  const best = bruteForceSchedule(mold, orders);
  assert.ok(best, '暴力算法找到可行方案');
  assert.equal(maintEvents(sched).length, best.maintenances, '保养次数与最优一致');
  assert.equal(sched.end, best.end, '完工时间与最优一致');
});
