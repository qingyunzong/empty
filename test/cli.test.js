'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../cli.js');

function runCli(spec) {
  // 与 CLI 相同的 JSON 进/出路径（沙箱禁止子进程，故进程内调用）
  return JSON.parse(JSON.stringify(run(JSON.parse(JSON.stringify(spec)))));
}

test('CLI: 读 JSON 全流程（枚举/冲突/抖动/覆盖/撤销）', () => {
  const results = runCli({
    H: '4',
    commands: [
      { op: 'addRule', id: 'maint', phase: '0', period: '3/2', duration: '1/2', jitter: ['-1/4', '1/4'] },
      { op: 'enumerate', rule: 'maint' },
      { op: 'addReservation', id: 'low', start: '0', end: '1', priority: 1 },
      { op: 'addReservation', id: 'high', start: '0', end: '1', priority: 5, permit: true },
      { op: 'check', reservation: 'low' },
      { op: 'checkAll' },
      { op: 'undo' },
      { op: 'reservation', id: 'low' },
      { op: 'addRule', id: 'bad', phase: '0', period: '0', duration: '1' },
      { op: 'enumerate', rule: 'maint' },
    ],
  });
  assert.equal(results.length, 10);
  // 枚举: 0, 3/2, 3
  assert.deepEqual(results[1].instances.map((i) => i.start), ['0', '3/2', '3']);
  // 覆盖链
  assert.deepEqual(results[3].overridden, ['low']);
  // low 与实例 [0,1/2) 确定冲突（抖动 [-1/4,1/4] 内恒冲突: 窗口 (-1/2,1) 全覆盖）
  assert.equal(results[4].status, 'conflict');
  // low 被覆盖后 checkAll 只剩 high
  assert.deepEqual(results[5].results, { high: 'conflict' });
  // 撤销覆盖 → low 恢复 active
  assert.equal(results[6].applied, true);
  assert.equal(results[7].reservation.status, 'active');
  // period<=0 回滚
  assert.equal(results[8].ok, false);
  assert.match(results[8].error, /period<=0/);
});

test('CLI: 抖动 possible 证书', () => {
  const results = runCli({
    H: '10',
    commands: [
      { op: 'addRule', id: 'r', phase: '0', period: '10', duration: '1', jitter: ['-1/2', '1/2'] },
      { op: 'addReservation', id: 'maybe', start: '4/3', end: '3' },
      { op: 'check', reservation: 'maybe' },
    ],
  });
  assert.equal(results[2].status, 'possible');
  const cert = results[2].instances[0].certificate;
  assert.equal(cert.conflictingJitter.lo, '1/3');
  assert.equal(cert.conflictingJitter.hi, '1/2');
  assert.equal(cert.witnessNoConflict, '-1/2');
});
