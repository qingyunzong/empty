import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';

const DSL = `
  site S {
    capacity 20 kW
    tariff { price 00:00-06:00 1 price 06:00-24:00 5 }
    template A { power 10 kW duration 30 min window 00:00-12:00 interruptible false }
    task t1 : A
  }
`;

test('增量：add-task 后重新求解', () => {
  const s = new Session();
  s.load(DSL);
  s.savepoint('base');
  const r1 = s.solve();
  assert.equal(r1.schedule.length, 1);
  s.addTaskDsl('task t2 : A { window 00:00-12:00 }');
  const r2 = s.solve();
  assert.equal(r2.schedule.length, 2);
  // 两任务都应挤进低价时段
  assert.equal(r2.cost, r1.cost * 2);
});

test('回滚：结果与全新会话一致，缓存不被污染', () => {
  const s = new Session();
  s.load(DSL);
  s.savepoint('base');
  const r1 = s.solve();
  s.addTaskDsl('task t2 : A { window 00:00-12:00 }');
  s.addTaskDsl('task t3 : A { window 00:00-12:00 } order t2 before t3');
  const r2 = s.solve();
  assert.equal(r2.schedule.length, 3);
  assert.ok(s.vm.cache.size > 0);
  s.rollback('base');
  // 缓存中不得残留被回滚任务的条目
  for (const key of s.vm.cache.keys()) {
    assert.ok(!key.startsWith('t2@') && !key.startsWith('t3@'), `缓存被污染: ${key}`);
  }
  const r3 = s.solve();
  assert.deepEqual(r3, r1);
  // 与全新会话结果一致
  const fresh = new Session();
  fresh.load(DSL);
  assert.deepEqual(r3, fresh.solve());
});

test('回滚：未知保存点报错', () => {
  const s = new Session();
  s.load(DSL);
  assert.throws(() => s.rollback('nope'), /保存点 "nope" 不存在/);
});

test('回滚：可回到更早的保存点', () => {
  const s = new Session();
  s.load(DSL);
  s.savepoint('one');
  s.addTaskDsl('task t2 : A');
  s.savepoint('two');
  s.addTaskDsl('task t3 : A');
  assert.equal(s.solve().schedule.length, 3);
  s.rollback('one');
  const r = s.solve();
  assert.equal(r.schedule.length, 1);
  assert.deepEqual(r.schedule[0].slots, [0, 1]);
});
