'use strict';

// 验收B：非法补丁（越界）被拒绝且原文件不变。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session } = require('../src/session');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-b-'));
  const file = path.join(dir, 'msg.jsonl');
  const rules = path.join(dir, 'rules.json');
  const lines = [
    { lineNo: 1, counterparty: 'A', currency: 'CNY', amount: 100, memo: '正常付款' },
    { lineNo: 2, counterparty: 'B', currency: 'USD', amount: 200, memo: '含敏感词alpha' },
    { lineNo: 3, counterparty: 'C', currency: 'EUR', amount: 300, memo: '普通备注' },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(rules, JSON.stringify({ rules: [{ id: 'E1', type: 'exact', pattern: '敏感词' }] }));
  return { dir, file, rules };
}

test('B: out-of-range patch rejected with BAD_PATCH, file unchanged', () => {
  const { file, rules } = setup();
  const before = fs.readFileSync(file);
  const s = new Session();
  s.load(file, rules);

  for (const badLine of [0, -1, 4, 100, 1.5, '2']) {
    assert.throws(
      () => s.patch(badLine, { lineNo: 9, counterparty: 'X', currency: 'CNY', amount: 1, memo: 'x' }),
      (e) => e.code === 'BAD_PATCH',
      `line ${badLine} should be BAD_PATCH`,
    );
  }
  assert.deepEqual(fs.readFileSync(file), before, 'file bytes must be unchanged');
});

test('B: malformed record rejected with BAD_PATCH, file unchanged', () => {
  const { file, rules } = setup();
  const before = fs.readFileSync(file);
  const s = new Session();
  s.load(file, rules);

  for (const bad of [null, 'str', 42, [1, 2], { lineNo: 1 } /* missing fields */]) {
    assert.throws(() => s.patch(2, bad), (e) => e.code === 'BAD_PATCH');
  }
  assert.deepEqual(fs.readFileSync(file), before);
});

test('B: valid patch succeeds and rewrites exactly one line', () => {
  const { file, rules } = setup();
  const s = new Session();
  s.load(file, rules);
  const rec = { lineNo: 2, counterparty: 'B', currency: 'USD', amount: 250, memo: '已更正' };
  const r = s.patch(2, rec);
  assert.deepEqual(r.window, [2, 2]);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], JSON.stringify(rec));
});
