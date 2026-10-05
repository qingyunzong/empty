import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ProductionSystem } from '../src/system.js';
import type { JobSpec } from '../src/state.js';

function jobs(): JobSpec[] {
  return [
    {
      jobId: 'J1',
      stages: [
        { stageId: 'cut', materials: { steel: 10 }, equipment: { CNC: 1 }, recovery: { steel: 10 } },
        { stageId: 'assemble', materials: { steel: 4, plastic: 6 }, equipment: { CNC: 1 }, recovery: { plastic: 4 } },
        { stageId: 'pack', materials: { plastic: 2, carton: 2 }, equipment: { PACK: 1 }, recovery: {} },
      ],
    },
    {
      jobId: 'J2',
      stages: [{ stageId: 'cut', materials: { steel: 8 }, equipment: { CNC: 1 }, recovery: { steel: 8 } }],
    },
  ];
}

function boot(): ProductionSystem {
  const sys = new ProductionSystem();
  sys.initStock({ steel: 100, plastic: 60, carton: 40 });
  sys.registerEquipment('CNC', 2);
  sys.registerEquipment('PACK', 1);
  sys.placeOrder('O1', jobs());
  return sys;
}

test('作业占用原料与设备，阶段完成后消耗并释放', () => {
  const sys = boot();
  sys.startStage('J1');
  assert.deepEqual(sys.state.materials['steel'], { onHand: 90, reserved: 10 });
  assert.deepEqual(sys.state.equipment['CNC'], { capacity: 2, inUse: 1 });

  sys.completeStage('J1');
  assert.deepEqual(sys.state.materials['steel'], { onHand: 90, reserved: 0 });
  assert.deepEqual(sys.state.equipment['CNC'], { capacity: 2, inUse: 0 });
  assert.deepEqual(sys.state.jobs['J1']?.consumed, { steel: 10 });
});

test('库存不足或设备占满时拒绝占用', () => {
  const sys = boot();
  sys.startStage('J1'); // CNC 1/2
  sys.startStage('J2'); // CNC 2/2
  const sys2 = new ProductionSystem();
  sys2.initStock({ steel: 5 });
  sys2.registerEquipment('CNC', 1);
  sys2.placeOrder('O9', [
    { jobId: 'JX', stages: [{ stageId: 'cut', materials: { steel: 10 }, equipment: {}, recovery: {} }] },
  ]);
  assert.throws(() => sys2.startStage('JX'), /insufficient steel/);
});

test('失败按阶段决定可回收原料：可回收保留，其余记损耗', () => {
  const sys = boot();
  sys.startStage('J1');
  sys.completeStage('J1');
  sys.startStage('J1'); // assemble: steel 4 + plastic 6
  sys.failStage('J1', 'weld crack');

  const job = sys.state.jobs['J1'];
  assert.equal(job?.status, 'failed');
  assert.deepEqual(job?.retained, { plastic: 4 }); // 阶段策略：plastic 可回收 4
  assert.deepEqual(job?.held, {});
  assert.deepEqual(sys.state.scrapped, { steel: 4, plastic: 2 }); // 其余损耗
  assert.deepEqual(sys.state.materials['plastic'], { onHand: 54, reserved: 4 });
  assert.deepEqual(sys.state.equipment['CNC'], { capacity: 2, inUse: 0 }); // 设备已释放
});

test('重试不再消耗已保留料，只为缺口新增占用', () => {
  const sys = boot();
  sys.startStage('J1');
  sys.completeStage('J1');
  sys.startStage('J1');
  sys.failStage('J1', 'weld crack');

  const plasticBefore = sys.state.materials['plastic']?.onHand;
  const steelBefore = sys.state.materials['steel']?.onHand;
  sys.retry('J1');

  // 缺口：steel 4 + plastic 2；plastic 4 来自保留料，不再次消耗库存
  assert.equal(sys.state.materials['plastic']?.onHand, (plasticBefore ?? 0) - 2);
  assert.equal(sys.state.materials['steel']?.onHand, (steelBefore ?? 0) - 4);

  const reserveEvent = sys.events.find((e) => e.type === 'MaterialsReserved' && e.attempt === 2);
  assert.deepEqual(reserveEvent?.type === 'MaterialsReserved' && reserveEvent.reserved, { steel: 4, plastic: 2 });
  assert.deepEqual(reserveEvent?.type === 'MaterialsReserved' && reserveEvent.fromRetained, { plastic: 4 });

  const job = sys.state.jobs['J1'];
  assert.deepEqual(job?.retained, {});
  assert.deepEqual(job?.held, { steel: 4, plastic: 6 });
});

test('整单取消产生逆向补料：在制与保留料退回，设备释放，已完工作业不受影响', () => {
  const sys = boot();
  // J1 完成 cut，assemble 失败（保留 plastic 4）
  sys.startStage('J1');
  sys.completeStage('J1');
  sys.startStage('J1');
  sys.failStage('J1', 'weld crack');
  // J2 cut 在制（held steel 8，占用 CNC）
  sys.startStage('J2');

  const steelBefore = sys.state.materials['steel']?.onHand ?? 0;
  const plasticBefore = sys.state.materials['plastic']?.onHand ?? 0;
  sys.cancelOrder('O1');

  // 逆向补料：J1 保留 plastic 4 退回；J2 在制 steel 8 退回
  assert.equal(sys.state.materials['plastic']?.onHand, plasticBefore + 4);
  assert.equal(sys.state.materials['steel']?.onHand, steelBefore + 8);
  assert.equal(sys.state.materials['plastic']?.reserved, 0);
  assert.equal(sys.state.materials['steel']?.reserved, 0);
  assert.deepEqual(sys.state.equipment['CNC'], { capacity: 2, inUse: 0 });

  assert.equal(sys.state.orders['O1']?.status, 'cancelled');
  assert.equal(sys.state.jobs['J1']?.status, 'cancelled');
  assert.equal(sys.state.jobs['J2']?.status, 'cancelled');

  const returned = sys.events.filter((e) => e.type === 'MaterialsReturned');
  assert.equal(returned.length, 2);
  assert.ok(returned.every((e) => e.type === 'MaterialsReturned' && e.reason === 'order-cancel'));

  // 已取消订单不可再作业
  assert.throws(() => sys.startStage('J1'), /not startable/);
  assert.throws(() => sys.cancelOrder('O1'), /already cancelled/);
});

test('全部阶段完成后作业与订单完工', () => {
  const sys = boot();
  for (let i = 0; i < 3; i += 1) {
    sys.startStage('J1');
    sys.completeStage('J1');
  }
  assert.equal(sys.state.jobs['J1']?.status, 'completed');
  sys.startStage('J2');
  sys.completeStage('J2');
  assert.equal(sys.state.jobs['J2']?.status, 'completed');
  assert.equal(sys.state.orders['O1']?.status, 'completed');
});
