'use strict';

// 验收D：patch 后增量结果等于全量重扫。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session } = require('../src/session');

const RULES = {
  rules: [
    { id: 'E1', type: 'exact', pattern: '敏感词' },
    { id: 'E2', type: 'exact', pattern: 'alpha' },
    { id: 'R1', type: 'regex', pattern: '[A-Z][A-Z]+' },
    { id: 'R2', type: 'regex', pattern: 'USD|CNY' },
  ],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-d-'));
  const file = path.join(dir, 'msg.jsonl');
  const rules = path.join(dir, 'rules.json');
  const memos = ['正常付款', '含敏感词一笔', 'alpha beta', '普通', '敏感词+alpha', '无', '尾行敏感词', 'ok'];
  const lines = memos.map((memo, i) => JSON.stringify({
    lineNo: i + 1, counterparty: 'CP' + (i + 1), currency: i % 2 ? 'USD' : 'CNY', amount: 100 + i, memo,
  }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.writeFileSync(rules, JSON.stringify(RULES));
  return { file, rules };
}

test('D: incremental patch result equals full rescan, for every line', () => {
  const { file, rules } = setup();
  const s = new Session();
  s.load(file, rules);
  const baseline = s.scan().hits;
  assert.ok(baseline.length > 0, 'baseline should have hits');

  const lineCount = 8;
  for (let ln = 1; ln <= lineCount; ln++) {
    // reset file
    const fresh = setup();
    const s1 = new Session();
    s1.load(fresh.file, fresh.rules);
    const rec = {
      lineNo: ln, counterparty: 'ZZ', currency: 'USD', amount: 999,
      memo: ln % 2 ? '更正后含敏感词' : 'clean memo alpha',
    };
    const pr = s1.patch(ln, rec);
    assert.deepEqual(pr.window, [ln, ln]);

    // full rescan of the patched file from scratch
    const s2 = new Session();
    s2.load(fresh.file, fresh.rules);
    const full = s2.scan().hits;

    assert.deepEqual(s1.allHits(), full, `patch line ${ln}: incremental != full rescan`);
    assert.deepEqual(pr.hits, full);
    assert.equal(pr.proof.window[0], ln);
    assert.equal(pr.proof.fileHashAfter, s1.fileHash);
  }
});
