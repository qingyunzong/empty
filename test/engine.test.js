import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetEngine } from '../src/engine.js';
import { checkOrderIndependence } from '../src/enumerate.js';

const baseConfig = {
  sitePowerKw: 100,
  piles: [
    { id: 'P1', powerKw: 50 },
    { id: 'P2', powerKw: 50 },
  ],
  tenants: [{ id: 'T1', dailyMinutes: 300 }],
  vehicles: [
    { id: 'V1', tenantId: 'T1', powerKw: 50 },
    { id: 'V2', tenantId: 'T1', powerKw: 50 },
    { id: 'V3', tenantId: 'T1', powerKw: 50 },
  ],
};

const onePileConfig = {
  sitePowerKw: 50,
  piles: [{ id: 'P1', powerKw: 50 }],
  tenants: [{ id: 'T1', dailyMinutes: 300 }],
  vehicles: [
    { id: 'V1', tenantId: 'T1', powerKw: 50 },
    { id: 'V2', tenantId: 'T1', powerKw: 50 },
    { id: 'V3', tenantId: 'T1', powerKw: 50 },
  ],
};

function feed(config, events) {
  const engine = new FleetEngine(config);
  for (const e of events) engine.ingest(e, e.ts);
  return engine;
}

test('乱序申请/释放最终归并正确', () => {
  const events = [
    { seq: 1, ts: 0, type: 'request', vehicleId: 'V1', minutes: 60 },
    { seq: 2, ts: 10, type: 'request', vehicleId: 'V2', minutes: 30 },
    { seq: 3, ts: 45, type: 'release', vehicleId: 'V1' },
    { seq: 4, ts: 20, type: 'request', vehicleId: 'V3', minutes: 30 },
  ];
  const inOrder = feed(baseConfig, events).report();
  const shuffled = feed(baseConfig, [events[2], events[0], events[3], events[1]]).report();
  assert.deepEqual(shuffled.timeline, inOrder.timeline);
  assert.deepEqual(shuffled.quotas, inOrder.quotas);
  // Expected merged timeline: V1 released at 45, V2 completes at 40 and V3
  // (queued at 20 because both piles were busy) starts once V2 frees a pile.
  assert.deepEqual(
    inOrder.timeline.map((s) => [s.vehicleId, s.start, s.end, s.reason]),
    [
      ['V2', 10, 40, 'completed'],
      ['V1', 0, 45, 'released'],
      ['V3', 40, 70, 'completed'],
    ],
  );
  assert.equal(inOrder.quotas.tenants[0].usedMinutes, 105);
});

test('紧急抢占保留已充电量并按老化重排等待队列', () => {
  const events = [
    { seq: 1, ts: 0, type: 'request', vehicleId: 'V1', minutes: 60 },
    { seq: 2, ts: 20, type: 'emergency', vehicleId: 'V2', minutes: 30 },
    { seq: 3, ts: 25, type: 'request', vehicleId: 'V3', minutes: 30 },
  ];
  const report = feed(onePileConfig, events).report();
  const tl = report.timeline;
  // V1 preempted at 20 keeping 20 charged minutes.
  assert.deepEqual(
    tl.map((s) => [s.vehicleId, s.start, s.end, s.minutes, s.reason]),
    [
      ['V1', 0, 20, 20, 'preempted'],
      ['V2', 20, 50, 30, 'completed'],
      ['V1', 50, 90, 40, 'completed'],
      ['V3', 90, 120, 30, 'completed'],
    ],
  );
  // Aging: preempted V1 (enqueued at 0) resumes before V3 (enqueued at 25).
  const v1Resume = tl.find((s) => s.vehicleId === 'V1' && s.reason === 'completed');
  const v3 = tl.find((s) => s.vehicleId === 'V3');
  assert.ok(v1Resume.start < v3.start);
  // V1 total charged = 20 (kept) + 40 = originally requested 60.
  const v1Total = tl.filter((s) => s.vehicleId === 'V1').reduce((a, s) => a + s.minutes, 0);
  assert.equal(v1Total, 60);
});

test('cutoff 前迟到事件触发重算并生成冲正证书', () => {
  const engine = new FleetEngine(onePileConfig);
  engine.ingest({ seq: 1, ts: 0, type: 'request', vehicleId: 'V1', minutes: 60 }, 0);
  engine.settle(100);
  assert.deepEqual(
    engine.report().bills.map((b) => [b.tenantId, b.minutes]),
    [['T1', 60]],
  );
  // Late event (business ts 10) arrives at 90, before the cutoff: recompute.
  const r = engine.ingest({ seq: 2, ts: 10, type: 'request', vehicleId: 'V2', minutes: 30 }, 90);
  assert.equal(r.status, 'applied');
  const report = engine.report();
  assert.equal(report.reversals.length, 1);
  const rev = report.reversals[0];
  assert.equal(rev.id, 'REV-1');
  assert.equal(rev.triggerSeq, 2);
  assert.deepEqual(
    rev.diffs.map((d) => [d.tenantId, d.beforeMinutes, d.afterMinutes, d.deltaMinutes]),
    [['T1', 60, 90, 30]],
  );
  // Recompute kept pile mutual exclusion and tenant quota consistent.
  assert.deepEqual(
    report.timeline.map((s) => [s.vehicleId, s.start, s.end]),
    [
      ['V1', 0, 60],
      ['V2', 60, 90],
    ],
  );
  assert.equal(report.quotas.tenants[0].usedMinutes, 90);
});

test('cutoff 后迟到事件被拒且已定结果不变', () => {
  const engine = new FleetEngine(onePileConfig);
  engine.ingest({ seq: 1, ts: 0, type: 'request', vehicleId: 'V1', minutes: 60 }, 0);
  engine.settle(100);
  const before = engine.report();
  const r = engine.ingest({ seq: 2, ts: 50, type: 'request', vehicleId: 'V2', minutes: 30 }, 150);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'arrived-after-cutoff');
  const after = engine.report();
  assert.equal(after.rejections.length, 1);
  assert.deepEqual(after.rejections[0], {
    seq: 2,
    reason: 'arrived-after-cutoff',
    eventTs: 50,
    arrivalTs: 150,
    cutoff: 100,
  });
  // Settled results are untouched.
  assert.deepEqual(after.timeline, before.timeline);
  assert.deepEqual(after.bills, before.bills);
  assert.deepEqual(after.quotas, before.quotas);
  assert.equal(after.reversals.length, 0);
});

test('超额功率、重复事件、未知车辆报错', () => {
  const engine = new FleetEngine(baseConfig);
  const r1 = engine.ingest({ seq: 1, ts: 0, type: 'request', vehicleId: 'V1', minutes: 30, powerKw: 500 });
  assert.equal(r1.status, 'error');
  assert.equal(r1.reason, 'power-exceeded');

  engine.ingest({ seq: 2, ts: 0, type: 'request', vehicleId: 'V1', minutes: 30 });
  const r2 = engine.ingest({ seq: 2, ts: 5, type: 'request', vehicleId: 'V2', minutes: 30 });
  assert.equal(r2.status, 'error');
  assert.equal(r2.reason, 'duplicate-event');

  const r3 = engine.ingest({ seq: 3, ts: 1, type: 'request', vehicleId: 'V9', minutes: 30 });
  assert.equal(r3.status, 'error');
  assert.equal(r3.reason, 'unknown-vehicle');

  const report = engine.report();
  assert.deepEqual(
    report.errors.map((e) => e.reason).sort(),
    ['duplicate-event', 'power-exceeded', 'unknown-vehicle'],
  );
  // Only the valid event was applied.
  assert.deepEqual(
    report.timeline.map((s) => [s.vehicleId, s.start, s.end]),
    [['V1', 0, 30]],
  );
});

test('租户每日充电分钟上限阻止超额调度', () => {
  const config = {
    ...onePileConfig,
    tenants: [{ id: 'T1', dailyMinutes: 45 }],
  };
  const report = feed(config, [
    { seq: 1, ts: 0, type: 'request', vehicleId: 'V1', minutes: 60 },
    { seq: 2, ts: 0, type: 'request', vehicleId: 'V2', minutes: 30 },
  ]).report();
  // Session capped at the remaining tenant quota; V2 never starts (quota used up).
  assert.deepEqual(
    report.timeline.map((s) => [s.vehicleId, s.minutes]),
    [['V1', 45]],
  );
  assert.equal(report.quotas.tenants[0].usedMinutes, 45);
  assert.equal(report.quotas.tenants[0].remainingMinutes, 0);
  assert.deepEqual(report.waiting.map((w) => w.vehicleId), ['V2']);
});

test('不超过 6 个事件时枚举全部合法到达顺序核对归并一致', () => {
  const events = [
    { seq: 1, ts: 0, type: 'request', vehicleId: 'V1', minutes: 50 },
    { seq: 2, ts: 5, type: 'request', vehicleId: 'V2', minutes: 40 },
    { seq: 3, ts: 10, type: 'request', vehicleId: 'V3', minutes: 60 },
    { seq: 4, ts: 30, type: 'release', vehicleId: 'V1' },
    { seq: 5, ts: 50, type: 'release', vehicleId: 'V2' },
    { seq: 6, ts: 70, type: 'release', vehicleId: 'V3' },
  ];
  const result = checkOrderIndependence(baseConfig, events);
  assert.equal(result.checked, 720);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});
