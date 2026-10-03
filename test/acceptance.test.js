'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulator } = require('../src/simulator');

// 3 任务 2 巷道夹具: 目标位互不重叠
function fixture() {
  return [
    { task_id: 't1', type: 'inbound', item: 'sku-1', to: 'A-01', priority: 1 },
    { task_id: 't2', type: 'move', item: 'sku-2', from: 'A-02', to: 'B-01', priority: 2 },
    { task_id: 't3', type: 'outbound', item: 'sku-3', from: 'B-02', priority: 1 },
  ];
}

// 生成多条事件链的全部交错 (保持每条链内部因果序)
function* interleave(chains, prefix = []) {
  if (chains.every((c) => c.length === 0)) {
    yield prefix;
    return;
  }
  for (let i = 0; i < chains.length; i++) {
    if (chains[i].length === 0) continue;
    const [head, ...rest] = chains[i];
    const next = chains.slice();
    next[i] = rest;
    yield* interleave(next, [...prefix, head]);
  }
}

function chain(id) {
  return [
    { type: 'assign', task_id: id },
    { type: 'start', task_id: id },
    { type: 'finish', task_id: id },
  ];
}

test('验收1: 3任务2巷道枚举事件交错, 任何时刻无两任务同货位', () => {
  const chains = [chain('t1'), chain('t2'), chain('t3')];
  let scenarios = 0;
  let eventApplications = 0;
  for (const events of interleave(chains)) {
    // 变体: 无取消; 在每个位置插入 cancel(t2)+safe_point(t2)
    const variants = [events];
    for (let pos = 0; pos <= events.length; pos++) {
      variants.push([
        ...events.slice(0, pos),
        { type: 'cancel', task_id: 't2' },
        { type: 'safe_point', task_id: 't2' },
        ...events.slice(pos),
      ]);
    }
    for (const variant of variants) {
      const sim = new Simulator(fixture());
      for (const ev of variant) {
        sim.applyEvent(ev);
        eventApplications++;
        const problems = sim.checkConsistency();
        assert.deepEqual(
          problems,
          [],
          `一致性破坏 @ ${JSON.stringify(ev)} in ${JSON.stringify(variant)}: ${problems}`
        );
      }
      // 终态: 每件货物至多出现在一个货位
      const items = Object.values(sim.finalSlots()).filter((x) => x !== null);
      assert.equal(new Set(items).size, items.length, '终态存在两位同货/同货两位');
      scenarios++;
    }
  }
  assert.ok(scenarios > 10000, `枚举规模不足: ${scenarios}`);
  console.log(`  [验收1] scenarios=${scenarios} eventApplications=${eventApplications}`);
});

test('验收2: started 任务 cancel 未到 safe_point 前不得释放目标位', () => {
  const sim = new Simulator(fixture());
  sim.applyEvent({ type: 'assign', task_id: 't2' });
  sim.applyEvent({ type: 'start', task_id: 't2' });
  const r = sim.applyEvent({ type: 'cancel', task_id: 't2' });
  assert.equal(r.status, 'cancelling');
  // safe_point 之前: 目标位仍被 t2 预留, 源位仍预留, 货物未回源
  assert.equal(sim.slots.get('B-01').reservedBy, 't2');
  assert.equal(sim.slots.get('A-02').reservedBy, 't2');
  assert.equal(sim.slots.get('A-02').item, null);
  assert.equal(sim.tasks.get('t2').state, 'started');
  // 其他任务不能占用该目标位
  const sim2 = new Simulator([
    { task_id: 'x1', type: 'move', item: 'i1', from: 'A-01', to: 'B-01', priority: 1 },
    { task_id: 'x2', type: 'inbound', item: 'i2', to: 'B-01', priority: 1 },
  ]);
  sim2.applyEvent({ type: 'assign', task_id: 'x1' });
  sim2.applyEvent({ type: 'start', task_id: 'x1' });
  sim2.applyEvent({ type: 'cancel', task_id: 'x1' });
  const conflict = sim2.applyEvent({ type: 'assign', task_id: 'x2' });
  assert.equal(conflict.code, 'SLOT_OCCUPIED');
  // safe_point 之后: 补偿回源, 目标位释放
  sim.applyEvent({ type: 'safe_point', task_id: 't2' });
  assert.equal(sim.slots.get('B-01').reservedBy, null);
  assert.equal(sim.slots.get('A-02').item, 'sku-2');
  assert.deepEqual(sim.checkConsistency(), []);
});

test('验收3: block/unblock 中两个 finish 汇合, 顺序可复现', () => {
  const scenario = () => {
    const sim = new Simulator([
      { task_id: 'p1', type: 'move', item: 'i1', from: 'A-01', to: 'B-01', priority: 2 },
      { task_id: 'p2', type: 'move', item: 'i2', from: 'A-02', to: 'B-02', priority: 1 },
    ]);
    for (const id of ['p1', 'p2']) {
      sim.applyEvent({ type: 'assign', task_id: id });
      sim.applyEvent({ type: 'start', task_id: id });
    }
    sim.applyEvent({ type: 'block_aisle', aisle: 'B' });
    sim.applyEvent({ type: 'finish', task_id: 'p1' }); // 先到达出口
    sim.applyEvent({ type: 'finish', task_id: 'p2' });
    sim.applyEvent({ type: 'unblock_aisle', aisle: 'B' });
    return sim;
  };
  const a = scenario();
  const b = scenario();
  assert.deepEqual(a.ledger, b.ledger, '两次运行 ledger 必须完全一致');
  const order = a.ledger.filter((e) => e.kind === 'finish').map((e) => e.task_id);
  assert.deepEqual(order, ['p2', 'p1'], '优先级高者先放行, 与到达序无关');
  assert.equal(a.finalSlots()['B-02'], 'i2');
  assert.equal(a.finalSlots()['B-01'], 'i1');
});

test('验收4: cancel 已 done 记 INVALID_STATE 但不中断后续事件', () => {
  const sim = new Simulator(fixture());
  sim.applyEvent({ type: 'assign', task_id: 't1' });
  sim.applyEvent({ type: 'start', task_id: 't1' });
  sim.applyEvent({ type: 'finish', task_id: 't1' });
  const r = sim.applyEvent({ type: 'cancel', task_id: 't1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_STATE');
  assert.equal(sim.errors.length, 1);
  assert.equal(sim.errors[0].code, 'INVALID_STATE');
  // 不中断: 后续事件正常处理
  assert.equal(sim.applyEvent({ type: 'assign', task_id: 't3' }).ok, true);
  assert.equal(sim.applyEvent({ type: 'start', task_id: 't3' }).ok, true);
  assert.equal(sim.applyEvent({ type: 'finish', task_id: 't3' }).ok, true);
  assert.equal(sim.tasks.get('t1').state, 'done');
  assert.equal(sim.finalSlots()['A-01'], 'sku-1');
  assert.deepEqual(sim.checkConsistency(), []);
});
