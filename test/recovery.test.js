'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wal, Ledger } = require('../lib/ledger');

function accounts() {
  return [
    { id: 'A1', cash: 10000 },
    { id: 'A2', securities: { SEC1: 100 } },
  ];
}

function freezes() {
  return [
    { account: 'A1', cash: 1000 },
    { account: 'A2', security: 'SEC1', quantity: 100 },
  ];
}

test('验收3a: 配对日志已写、提交日志未写 -> 重启回滚配对', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const walPath = path.join(dir, 'a.wal');
  const wal = new Wal(walPath);
  wal.append({ op: 'pair', id: 'P1', freezes: freezes() });
  // 崩溃点：pair_done 未写

  const ledger = Ledger.recover(accounts(), walPath);
  assert.equal(ledger.get('A1').cash, 10000); // 回滚后资金恢复
  assert.equal(ledger.get('A2').securities.SEC1, 100); // 证券恢复
  assert.equal(ledger.holds.size, 0);
  const records = new Wal(walPath).readAll();
  assert.ok(records.some((r) => r.op === 'unfreeze' && r.id === 'P1' && r.reason === 'rollback'));
  assert.ok(records.some((r) => r.op === 'unfreeze_done' && r.id === 'P1'));
});

test('验收3b: 解冻日志已写、完成日志未写 -> 重启自动完成解冻', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const walPath = path.join(dir, 'b.wal');
  const wal = new Wal(walPath);
  wal.append({ op: 'pair', id: 'P1', freezes: freezes() });
  wal.append({ op: 'pair_done', id: 'P1' });
  wal.append({ op: 'unfreeze', id: 'P1' });
  // 崩溃点：unfreeze_done 未写

  const ledger = Ledger.recover(accounts(), walPath);
  assert.equal(ledger.get('A1').cash, 10000);
  assert.equal(ledger.get('A2').securities.SEC1, 100);
  assert.equal(ledger.holds.size, 0);
  const records = new Wal(walPath).readAll();
  assert.equal(records.filter((r) => r.op === 'unfreeze_done' && r.id === 'P1').length, 1);

  // 再次恢复幂等：不重复解冻、不重复补日志
  const again = Ledger.recover(accounts(), walPath);
  assert.equal(again.get('A1').cash, 10000);
  assert.equal(new Wal(walPath).readAll().filter((r) => r.op === 'unfreeze_done').length, 1);
});

test('验收3c: 已提交配对恢复后保持冻结且不得重复冻结', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const walPath = path.join(dir, 'c.wal');
  const ledger1 = new Ledger(accounts(), new Wal(walPath));
  ledger1.freeze('P1', freezes());
  assert.equal(ledger1.get('A1').cash, 9000);

  const ledger2 = Ledger.recover(accounts(), walPath);
  assert.equal(ledger2.get('A1').cash, 9000); // 冻结仍然生效
  assert.equal(ledger2.get('A2').securities.SEC1, 0);
  assert.equal(ledger2.holds.size, 1);

  // 重复恢复不得重复冻结
  const ledger3 = Ledger.recover(accounts(), walPath);
  assert.equal(ledger3.get('A1').cash, 9000);
  assert.equal(ledger3.holds.size, 1);
});
