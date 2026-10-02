import test from 'node:test';
import assert from 'node:assert/strict';
import { VM } from '../src/vm.js';
import { compilePlan, compilePlacement } from '../src/compiler.js';

const mkSpec = () => ({
  prices: new Array(96).fill(2),
  carbonIntensity: new Array(96).fill(0.5),
  maintenance: [4, 5],
  capacity: 15,
  tasks: [{ id: 't1', power: 4 }, { id: 't2', power: 8 }],
});

test('VM：字节码计算槽负荷、费用、碳排、峰值', () => {
  const spec = mkSpec();
  const vm = new VM();
  const r = vm.run(compilePlan(spec, [
    { task: 't1', slots: [0, 1] },
    { task: 't2', slots: [1, 2] },
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.load.slice(0, 4), [4, 12, 8, 0]);
  assert.equal(r.peak, 12);
  // 费用：(4+12+8) kW * 0.25h * 2 = 12
  assert.equal(r.cost, 12);
  assert.equal(r.carbon, 3);
});

test('VM：容量与维护断言产生违例', () => {
  const spec = mkSpec();
  const vm = new VM();
  const r = vm.run(compilePlan(spec, [
    { task: 't2', slots: [4, 5] }, // 占用维护槽
  ]));
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('维护槽')));
  const r2 = vm.run(compilePlan(spec, [
    { task: 't2', slots: [0] },
    { task: 't2', slots: [0] }, // 16 > 15
  ]));
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => v.includes('超过容量')));
});

test('VM：缓存命中与保存点回滚', () => {
  const spec = mkSpec();
  const vm = new VM();
  const t = { id: 't1', power: 4 };
  const p = compilePlacement(t, [0, 1], spec);
  const a = vm.run(p, 't1@0,1');
  const marker = vm.snapshot();
  vm.run(compilePlacement(t, [2, 3], spec), 't1@2,3');
  assert.equal(vm.cache.size, 2);
  const b = vm.run(p, 't1@0,1');
  assert.equal(b, a); // 命中缓存返回同一对象
  vm.rollbackTo(marker);
  assert.equal(vm.cache.size, 1);
  assert.ok(!vm.cache.has('t1@2,3'));
});
