import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSite } from '../src/parser.js';
import { check, TypeCheckError } from '../src/types.js';

const checkDsl = (text) => check(parseSite(text));

test('类型：功率单位错误报错并带行列', () => {
  assert.throws(
    () => checkDsl('site A {\n  template P { power 10 kWh }\n}'),
    (e) => e instanceof TypeCheckError && e.line === 2 && /kW/.test(e.message),
  );
});

test('类型：时长未对齐 15 分钟槽', () => {
  assert.throws(
    () => checkDsl('site A { template P { power 1 kW duration 40 min window 08:00-10:00 } task t : P }'),
    (e) => e instanceof TypeCheckError && /15 分钟槽/.test(e.message),
  );
});

test('类型：时刻未对齐 15 分钟槽', () => {
  assert.throws(
    () => checkDsl('site A { template P { power 1 kW duration 30 min window 08:20-10:00 } task t : P }'),
    (e) => e instanceof TypeCheckError && /08:20/.test(e.message),
  );
});

test('类型：能量字段换算为时长（5 kWh / 10 kW = 30 min = 2 槽）', () => {
  const spec = checkDsl('site A { template P { power 10 kW energy 5 kWh window 08:00-10:00 } task t : P }');
  assert.equal(spec.tasks[0].durationSlots, 2);
});

test('类型：duration 与 energy 互斥', () => {
  assert.throws(
    () => checkDsl('site A { template P { power 1 kW duration 30 min energy 1 kWh window 08:00-10:00 } task t : P }'),
    /只能二选一/,
  );
});

test('作用域：子模板遮蔽父模板字段，父模板不受影响', () => {
  const spec = checkDsl(`
    site A {
      template P { power 10 kW duration 60 min window 08:00-20:00 }
      template Q : P { power 20 kW }
      task p1 : P
      task q1 : Q
    }
  `);
  assert.equal(spec.tasks[0].power, 10);
  assert.equal(spec.tasks[1].power, 20);
});

test('作用域：任务覆盖模板字段', () => {
  const spec = checkDsl(`
    site A {
      template P { power 10 kW duration 60 min window 08:00-20:00 }
      task p1 : P { duration 30 min }
    }
  `);
  assert.equal(spec.tasks[0].durationSlots, 2);
});

test('作用域：父模板必须先定义（词法作用域）', () => {
  assert.throws(
    () => checkDsl('site A { template Q : P { power 1 kW } template P { power 2 kW } }'),
    /未在此之前定义/,
  );
});

test('作用域：同一作用域字段重复定义报错', () => {
  assert.throws(
    () => checkDsl('site A { template P { power 1 kW power 2 kW } }'),
    /重复定义/,
  );
});

test('类型：未定义模板引用报错', () => {
  assert.throws(
    () => checkDsl('site A { task t : Nope }'),
    (e) => e instanceof TypeCheckError && /未定义的模板/.test(e.message),
  );
});

test('类型：电价时段重叠报错', () => {
  assert.throws(
    () => checkDsl('site A { tariff { price 00:00-06:00 0.3 price 05:00-07:00 0.5 } }'),
    /重叠/,
  );
});

test('类型：目标表达式未知变量报错', () => {
  assert.throws(
    () => checkDsl('site A { minimize cost + foo }'),
    /未知变量 "foo"/,
  );
});

test('类型：order 引用未定义任务报错', () => {
  assert.throws(
    () => checkDsl('site A { template P { power 1 kW duration 30 min window 08:00-10:00 } task t : P order t before x }'),
    /未定义的任务 "x"/,
  );
});
