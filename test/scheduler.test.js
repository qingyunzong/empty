'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler, ValidationError } = require('../src/scheduler');
const { Fraction } = require('../src/fraction');

test('验收1: 枚举 [0,H] 内全部实例并与逐实例比较', () => {
  const s = new Scheduler();
  s.addRule({ id: 'r', phase: '1/2', period: '3/4', duration: '1/4' });
  const instances = s.enumerate('r', '4');
  // 逐实例手工推算: start = 1/2 + k*3/4 < 4
  const expectedStarts = ['1/2', '5/4', '2', '11/4', '7/2'];
  assert.equal(instances.length, expectedStarts.length);
  for (let k = 0; k < instances.length; k += 1) {
    assert.equal(instances[k].index, k);
    assert.equal(instances[k].start.toString(), expectedStarts[k]);
    // end = start + duration，逐实例校验
    assert.equal(instances[k].end.toString(), Fraction.parse(expectedStarts[k]).add(Fraction.parse('1/4')).toString());
  }
  // 与朴素逐 k 循环交叉验证
  const naive = [];
  for (let k = 0; ; k += 1) {
    const start = Fraction.parse('1/2').add(Fraction.parse(String(k)).mul(Fraction.parse('3/4')));
    if (!start.lt(Fraction.parse('4'))) break;
    naive.push(start.toString());
  }
  assert.deepEqual(instances.map((i) => i.start.toString()), naive);
  // 边界: start == H 的实例不包含（左闭右开视窗）
  const s2 = new Scheduler();
  s2.addRule({ id: 'r', phase: '0', period: '1', duration: '1/2' });
  assert.deepEqual(s2.enumerate('r', '3').map((i) => i.start.toString()), ['0', '1', '2']);
});

test('验收2: [0,1) 与 [1,2) 边界相等无冲突，重叠区间有冲突', () => {
  const s = new Scheduler();
  s.addRule({ id: 'r', phase: '0', period: '10', duration: '1' }); // 实例 [0,1)
  s.addReservation({ id: 'adjacent', start: '1', end: '2' }); // [1,2) 边界相接
  s.addReservation({ id: 'overlap', start: '0', end: '1' }); // 与 [0,1) 完全重叠
  s.addReservation({ id: 'partial', start: '1/2', end: '3/2' }); // 内部相交
  assert.equal(s.checkReservation('adjacent', '10').status, 'none');
  assert.equal(s.checkReservation('adjacent', '10').instances.length, 0);
  assert.equal(s.checkReservation('overlap', '10').status, 'conflict');
  assert.equal(s.checkReservation('partial', '10').status, 'conflict');
  // 冲突实例内容
  const hit = s.checkReservation('overlap', '10').instances[0];
  assert.equal(hit.rule, 'r');
  assert.equal(hit.index, 0);
  assert.equal(hit.start.toString(), '0');
  assert.equal(hit.end.toString(), '1');
});

test('验收3: 抖动区间导致 possible 并给出边界证书', () => {
  const s = new Scheduler();
  // 实例 [0,1)，抖动 [-1/2, 1/2]
  s.addRule({ id: 'r', phase: '0', period: '10', duration: '1', jitter: ['-1/2', '1/2'] });
  // 冲突 ⟺ j ∈ (r-s-d, e-s) = (4/3-0-1, 3-0) = (1/3, 3)；与 [-1/2,1/2] 交集 (1/3, 1/2] 非空但不全覆盖
  s.addReservation({ id: 'maybe', start: '4/3', end: '3' });
  const res = s.checkReservation('maybe', '10');
  assert.equal(res.status, 'possible');
  assert.equal(res.instances.length, 1);
  const cert = res.instances[0].certificate;
  // 边界证书: 冲突窗口与抖动区间交集
  assert.equal(cert.conflictWindow.lo.toString(), '1/3');
  assert.equal(cert.conflictWindow.hi.toString(), '3');
  assert.equal(cert.jitterInterval[0].toString(), '-1/2');
  assert.equal(cert.jitterInterval[1].toString(), '1/2');
  assert.equal(cert.conflictingJitter.lo.toString(), '1/3');
  assert.equal(cert.conflictingJitter.hi.toString(), '1/2');
  // 见证点: 冲突抖动与不冲突抖动
  assert.ok(Fraction.parse(cert.witnessConflict).gt(Fraction.parse('1/3')));
  assert.ok(Fraction.parse(cert.witnessConflict).lte(Fraction.parse('1/2')));
  assert.equal(cert.witnessNoConflict.toString(), '-1/2');

  // 全抖动范围都冲突 → 确定冲突
  s.addReservation({ id: 'sure', start: '-1', end: '3' });
  assert.equal(s.checkReservation('sure', '10').status, 'conflict');
  // 抖动也够不到 → 无冲突
  s.addReservation({ id: 'far', start: '2', end: '3' });
  assert.equal(s.checkReservation('far', '10').status, 'none');
  // 无抖动规则只有 conflict/none
  const s2 = new Scheduler();
  s2.addRule({ id: 'r', phase: '0', period: '10', duration: '1' });
  s2.addReservation({ id: 'x', start: '3/2', end: '2' });
  assert.equal(s2.checkReservation('x', '10').status, 'none');
});

test('验收4: 高优先级 permit 覆盖低优先级，撤销后恢复', () => {
  const s = new Scheduler();
  s.addReservation({ id: 'low', start: '0', end: '2', priority: 1 });
  const result = s.addReservation({ id: 'high', start: '1', end: '3', priority: 5, permit: true });
  assert.deepEqual(result.overridden, ['low']);
  assert.equal(s.getReservation('low').status, 'overridden');
  assert.equal(s.getReservation('low').overriddenBy, 'high');
  // 覆盖 id 链记录在高优先级预留上
  assert.deepEqual(s.getReservation('high').overrides, ['low']);
  assert.deepEqual(s.overrideChain('high'), ['low']);
  // 被覆盖的预留不参与 checkAll
  assert.deepEqual(s.checkAll('10'), { high: 'none' });
  // 撤销覆盖 → 低优先级恢复
  assert.equal(s.undo(), true);
  assert.equal(s.getReservation('low').status, 'active');
  assert.equal(s.getReservation('low').overriddenBy, null);
  assert.equal(s.getReservation('high'), null);
  // 重做 → 再次覆盖
  assert.equal(s.redo(), true);
  assert.equal(s.getReservation('low').status, 'overridden');
  // 无 permit 不覆盖
  const s2 = new Scheduler();
  s2.addReservation({ id: 'low', start: '0', end: '2', priority: 1 });
  const r2 = s2.addReservation({ id: 'high', start: '1', end: '3', priority: 5 });
  assert.deepEqual(r2.conflicts, ['low']);
  assert.deepEqual(r2.overridden, []);
  assert.equal(s2.getReservation('low').status, 'active');
  // permit 不能覆盖同级或更高级
  const s3 = new Scheduler();
  s3.addReservation({ id: 'boss', start: '0', end: '2', priority: 9 });
  const r3 = s3.addReservation({ id: 'mid', start: '1', end: '3', priority: 5, permit: true });
  assert.deepEqual(r3.overridden, []);
  assert.equal(s3.getReservation('boss').status, 'active');
});

test('事务: period<=0、end<=start、分母为0 均回滚', () => {
  const s = new Scheduler();
  s.addRule({ id: 'ok', phase: '0', period: '1', duration: '1/2' });
  // period <= 0
  assert.throws(() => s.addRule({ id: 'bad', phase: '0', period: '0', duration: '1' }), ValidationError);
  assert.equal(s.getRule('bad'), null);
  assert.throws(() => s.addRule({ id: 'bad2', phase: '0', period: '-1/2', duration: '1' }), /period<=0|必须非负/);
  // 分母为0
  assert.throws(() => s.addRule({ id: 'bad3', phase: '1/0', period: '1', duration: '1' }), /分母为0/);
  assert.equal(s.rules.size, 1);
  // 修改规则为非法值 → 回滚，原规则不变
  assert.throws(() => s.updateRule('ok', { period: '0' }), /period<=0/);
  assert.equal(s.getRule('ok').period.toString(), '1');
  // end <= start
  s.addReservation({ id: 'keep', start: '0', end: '1' });
  assert.throws(() => s.addReservation({ id: 'badres', start: '2', end: '2' }), /end<=start/);
  assert.throws(() => s.addReservation({ id: 'badres2', start: '3', end: '1' }), /end<=start/);
  assert.equal(s.reservations.size, 1);
  // 多操作事务中途失败 → 整体回滚
  assert.throws(() => s.transaction('batch', (tx) => {
    tx.addRule({ id: 't1', phase: '0', period: '1', duration: '1' });
    tx.addRule({ id: 't2', phase: '0', period: '0', duration: '1' });
  }), /period<=0/);
  assert.equal(s.getRule('t1'), null);
  assert.equal(s.rules.size, 1);
});

test('undo/redo: 规则增改与历史分支', () => {
  const s = new Scheduler();
  s.addRule({ id: 'a', phase: '0', period: '1', duration: '1' });
  s.updateRule('a', { period: '2' });
  assert.equal(s.getRule('a').period.toString(), '2');
  s.undo();
  assert.equal(s.getRule('a').period.toString(), '1');
  s.undo();
  assert.equal(s.getRule('a'), null);
  assert.equal(s.undo(), false); // 空历史
  s.redo();
  s.redo();
  assert.equal(s.getRule('a').period.toString(), '2');
  assert.equal(s.redo(), false);
  // 新提交清空 redo 栈
  s.undo();
  s.updateRule('a', { duration: '1/3' });
  assert.equal(s.redo(), false);
  assert.equal(s.getRule('a').duration.toString(), '1/3');
});

test('有理数解析与运算', () => {
  assert.equal(Fraction.parse('2/4').toString(), '1/2');
  assert.equal(Fraction.parse('-3/6').toString(), '-1/2');
  assert.equal(Fraction.parse('4/-2').toString(), '-2');
  assert.equal(Fraction.parse(3).toString(), '3');
  assert.equal(Fraction.parse({ num: 6, den: 8 }).toString(), '3/4');
  assert.equal(Fraction.parse('1/3').add(Fraction.parse('1/6')).toString(), '1/2');
  assert.throws(() => Fraction.parse('1/0'), /分母为0/);
  assert.throws(() => Fraction.parse('0.5'), ValidationError);
});
