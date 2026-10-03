'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulator } = require('../src/simulator');

function inboundTask() {
  return [{ task_id: 't1', type: 'inbound', item: 'sku-1', to: 'A-01', priority: 1 }];
}

test('状态机主流程 created->assigned->started->done', () => {
  const sim = new Simulator(inboundTask());
  assert.equal(sim.applyEvent({ type: 'assign', task_id: 't1' }).status, 'assigned');
  assert.equal(sim.applyEvent({ type: 'start', task_id: 't1' }).status, 'started');
  assert.equal(sim.applyEvent({ type: 'finish', task_id: 't1' }).status, 'done');
  assert.equal(sim.tasks.get('t1').state, 'done');
  assert.equal(sim.finalSlots()['A-01'], 'sku-1');
  assert.deepEqual(sim.checkConsistency(), []);
});

test('非法跃迁记 INVALID_STATE 且不改变状态', () => {
  const sim = new Simulator(inboundTask());
  const r = sim.applyEvent({ type: 'finish', task_id: 't1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_STATE');
  assert.equal(sim.tasks.get('t1').state, 'created');
  assert.equal(sim.errors.length, 1);
});

test('重复 cancel (未 started) 幂等返回同一结果', () => {
  const sim = new Simulator(inboundTask());
  sim.applyEvent({ type: 'assign', task_id: 't1' });
  const r1 = sim.applyEvent({ type: 'cancel', task_id: 't1' });
  const r2 = sim.applyEvent({ type: 'cancel', task_id: 't1' });
  assert.deepEqual(r1, r2);
  assert.equal(r1.mode, 'immediate');
  assert.equal(sim.ledger.filter((e) => e.kind === 'cancel').length, 1);
  assert.equal(sim.slots.get('A-01').reservedBy, null);
});

test('带 id 事件幂等去重', () => {
  const sim = new Simulator(inboundTask());
  const ev = { id: 'evt-1', type: 'assign', task_id: 't1' };
  const r1 = sim.applyEvent(ev);
  const r2 = sim.applyEvent({ id: 'evt-1', type: 'assign', task_id: 't1' });
  assert.deepEqual(r1, r2);
  assert.equal(sim.ledger.filter((e) => e.kind === 'assign').length, 1);
});

test('move 任务 started 取消: safe_point 后补偿回源位', () => {
  const sim = new Simulator([
    { task_id: 'm1', type: 'move', item: 'sku-9', from: 'A-01', to: 'B-01', priority: 1 },
  ]);
  sim.applyEvent({ type: 'assign', task_id: 'm1' });
  sim.applyEvent({ type: 'start', task_id: 'm1' });
  assert.equal(sim.slots.get('A-01').item, null);
  const r = sim.applyEvent({ type: 'cancel', task_id: 'm1' });
  assert.equal(r.status, 'cancelling');
  const done = sim.applyEvent({ type: 'safe_point', task_id: 'm1' });
  assert.equal(done.mode, 'compensated');
  assert.equal(sim.slots.get('A-01').item, 'sku-9');
  assert.equal(sim.slots.get('B-01').reservedBy, null);
  assert.equal(sim.tasks.get('m1').state, 'cancelled');
  assert.deepEqual(sim.checkConsistency(), []);
});

test('assign 目标位被占记 SLOT_OCCUPIED', () => {
  const sim = new Simulator({
    slots: [{ id: 'A-01', item: 'sku-x' }],
    tasks: [{ task_id: 't1', type: 'inbound', item: 'sku-1', to: 'A-01' }],
  });
  const r = sim.applyEvent({ type: 'assign', task_id: 't1' });
  assert.equal(r.code, 'SLOT_OCCUPIED');
  assert.equal(sim.tasks.get('t1').state, 'created');
});

test('阻塞巷道 finish 排队, unblock 按优先级/到达序/task_id 放行', () => {
  const sim = new Simulator([
    { task_id: 'tb', type: 'inbound', item: 'b', to: 'A-02', priority: 2 },
    { task_id: 'ta', type: 'inbound', item: 'a', to: 'A-01', priority: 1 },
    { task_id: 'tc', type: 'inbound', item: 'c', to: 'A-03', priority: 1 },
  ]);
  for (const id of ['ta', 'tb', 'tc']) {
    sim.applyEvent({ type: 'assign', task_id: id });
    sim.applyEvent({ type: 'start', task_id: id });
  }
  sim.applyEvent({ type: 'block_aisle', aisle: 'A' });
  assert.equal(sim.applyEvent({ type: 'finish', task_id: 'tc' }).status, 'queued'); // 先到达
  assert.equal(sim.applyEvent({ type: 'finish', task_id: 'tb' }).status, 'queued');
  assert.equal(sim.applyEvent({ type: 'finish', task_id: 'ta' }).status, 'queued');
  sim.applyEvent({ type: 'unblock_aisle', aisle: 'A' });
  const order = sim.ledger.filter((e) => e.kind === 'finish').map((e) => e.task_id);
  // ta(p1) 先于 tc(p1, 到达更早? tc 先到达) -> 到达序 tc 在前; tb(p2) 最后
  assert.deepEqual(order, ['tc', 'ta', 'tb']);
  assert.deepEqual(sim.checkConsistency(), []);
});

test('优先级与到达序均平局时按 task_id', () => {
  const sim = new Simulator([
    { task_id: 'tz', type: 'inbound', item: 'z', to: 'A-02', priority: 1 },
    { task_id: 'ty', type: 'inbound', item: 'y', to: 'A-01', priority: 1 },
  ]);
  // 构造相同 arrival: 直接注入队列
  for (const id of ['ty', 'tz']) {
    sim.applyEvent({ type: 'assign', task_id: id });
    sim.applyEvent({ type: 'start', task_id: id });
  }
  sim.applyEvent({ type: 'block_aisle', aisle: 'A' });
  sim.applyEvent({ type: 'finish', task_id: 'tz' });
  sim.applyEvent({ type: 'finish', task_id: 'ty' });
  sim.tasks.get('tz').arrival = sim.tasks.get('ty').arrival; // 强制平局
  sim.applyEvent({ type: 'unblock_aisle', aisle: 'A' });
  const order = sim.ledger.filter((e) => e.kind === 'finish').map((e) => e.task_id);
  assert.deepEqual(order, ['ty', 'tz']);
});
