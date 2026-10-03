'use strict';

// 错误码：DUP_RULE、OFFSET_OVERFLOW。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session } = require('../src/session');
const { MAX_LINES } = require('../src/session');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'scan-x-')); }

test('DUP_RULE: duplicate rule id and duplicate exact pattern rejected', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'm.jsonl');
  fs.writeFileSync(file, JSON.stringify({ lineNo: 1, counterparty: 'A', currency: 'CNY', amount: 1, memo: 'x' }) + '\n');

  const dupId = path.join(dir, 'r1.json');
  fs.writeFileSync(dupId, JSON.stringify({ rules: [
    { id: 'E1', type: 'exact', pattern: 'a' },
    { id: 'E1', type: 'exact', pattern: 'b' },
  ] }));
  const s1 = new Session();
  assert.throws(() => s1.load(file, dupId), (e) => e.code === 'DUP_RULE');

  const dupPat = path.join(dir, 'r2.json');
  fs.writeFileSync(dupPat, JSON.stringify({ rules: [
    { id: 'E1', type: 'exact', pattern: 'a' },
    { id: 'E2', type: 'exact', pattern: 'a' },
  ] }));
  const s2 = new Session();
  assert.throws(() => s2.load(file, dupPat), (e) => e.code === 'DUP_RULE');
});

test('OFFSET_OVERFLOW: file exceeding line limit rejected', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'big.jsonl');
  const rules = path.join(dir, 'rules.json');
  const line = JSON.stringify({ lineNo: 1, counterparty: 'A', currency: 'CNY', amount: 1, memo: 'x' });
  fs.writeFileSync(file, (line + '\n').repeat(MAX_LINES + 1));
  fs.writeFileSync(rules, JSON.stringify({ rules: [{ id: 'E1', type: 'exact', pattern: 'x' }] }));
  const s = new Session();
  assert.throws(() => s.load(file, rules), (e) => e.code === 'OFFSET_OVERFLOW');
});
