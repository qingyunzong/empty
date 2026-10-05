import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stateCertificate } from '../src/certificate.js';
import { buildLedger } from '../src/ledger.js';
import { replay, replayCertificate, verifyAgainstReplay } from '../src/replay.js';
import { ProductionSystem } from '../src/system.js';
import type { Event } from '../src/events.js';

/** 覆盖失败、重试、整单取消的完整场景 */
function scenario(): ProductionSystem {
  const sys = new ProductionSystem();
  sys.initStock({ steel: 100, plastic: 60, carton: 40 });
  sys.registerEquipment('CNC', 2);
  sys.registerEquipment('PACK', 1);
  sys.placeOrder('O1', [
    {
      jobId: 'J1',
      stages: [
        { stageId: 'cut', materials: { steel: 10 }, equipment: { CNC: 1 }, recovery: { steel: 10 } },
        { stageId: 'assemble', materials: { steel: 4, plastic: 6 }, equipment: { CNC: 1 }, recovery: { plastic: 4 } },
        { stageId: 'pack', materials: { plastic: 2, carton: 2 }, equipment: { PACK: 1 }, recovery: {} },
      ],
    },
    { jobId: 'J2', stages: [{ stageId: 'cut', materials: { steel: 8 }, equipment: { CNC: 1 }, recovery: { steel: 8 } }] },
  ]);
  sys.startStage('J1');
  sys.completeStage('J1');
  sys.startStage('J1');
  sys.failStage('J1', 'weld crack');
  sys.retry('J1');
  sys.completeStage('J1');
  sys.startStage('J1');
  sys.completeStage('J1');
  sys.startStage('J2');
  sys.cancelOrder('O1');
  return sys;
}

test('状态证书与从头重放一致', () => {
  const sys = scenario();
  const live = stateCertificate(sys.state, sys.events.length);
  assert.equal(replayCertificate(sys.events), live);
  assert.ok(verifyAgainstReplay(sys.events, live));
});

test('事件顺序显式：乱序重放被拒绝', () => {
  const sys = scenario();
  const shuffled: Event[] = [...sys.events];
  const a = shuffled[3];
  const b = shuffled[4];
  if (!a || !b) throw new Error('scenario too short');
  shuffled[3] = b;
  shuffled[4] = a;
  assert.throws(() => replay(shuffled), /event order violated/);
});

test('篡改事件载荷导致证书不一致', () => {
  const sys = scenario();
  const live = stateCertificate(sys.state, sys.events.length);
  const tampered: Event[] = sys.events.map((event) =>
    event.type === 'MaterialsReturned' ? { ...event, items: { steel: 7 } } : event,
  );
  assert.notEqual(replayCertificate(tampered), live);
});

test('物料账与终态库存对账一致', () => {
  const sys = scenario();
  const rows = buildLedger(sys.events);
  const onHand: Record<string, number> = {};
  const reserved: Record<string, number> = {};
  for (const row of rows) {
    onHand[row.material] = (onHand[row.material] ?? 0) + row.deltaOnHand;
    reserved[row.material] = (reserved[row.material] ?? 0) + row.deltaReserved;
  }
  for (const [material, entry] of Object.entries(sys.state.materials)) {
    assert.equal(onHand[material] ?? 0, entry.onHand, `${material} onHand`);
    assert.equal(reserved[material] ?? 0, entry.reserved, `${material} reserved`);
  }
  // 损耗账：scrap 分录合计等于状态中的 scrapped
  const scrapped: Record<string, number> = {};
  for (const row of rows) {
    if (row.kind === 'scrap') scrapped[row.material] = (scrapped[row.material] ?? 0) - row.deltaReserved;
  }
  assert.deepEqual(scrapped, sys.state.scrapped);
});

test('确定性：同一事件流两次重放证书相同', () => {
  const sys = scenario();
  assert.equal(replayCertificate(sys.events), replayCertificate(sys.events));
});
