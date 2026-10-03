'use strict';

// 验收E：篡改 proof 必须 verify 失败（PROOF_MISMATCH）；未篡改则通过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session } = require('../src/session');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-e-'));
  const file = path.join(dir, 'msg.jsonl');
  const rules = path.join(dir, 'rules.json');
  const lines = [
    { lineNo: 1, counterparty: 'A', currency: 'CNY', amount: 100, memo: '含敏感词' },
    { lineNo: 2, counterparty: 'B', currency: 'USD', amount: 200, memo: 'alpha 出现' },
    { lineNo: 3, counterparty: 'C', currency: 'EUR', amount: 300, memo: '干净' },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(rules, JSON.stringify({
    rules: [
      { id: 'E1', type: 'exact', pattern: '敏感词' },
      { id: 'E2', type: 'exact', pattern: 'alpha' },
      { id: 'R1', type: 'regex', pattern: '[A-Z]+' },
    ],
  }));
  return { file, rules };
}

test('E: genuine proof verifies; any tampering fails with PROOF_MISMATCH', () => {
  const { file, rules } = setup();
  const s = new Session();
  s.load(file, rules);
  const { proof } = s.scan();

  // 1) untampered proof passes
  const ok = s.verify(JSON.parse(JSON.stringify(proof)));
  assert.equal(ok.verified, true);

  const tampered = (fn) => {
    const p = JSON.parse(JSON.stringify(proof));
    fn(p);
    return p;
  };
  const cases = {
    hitsHash: (p) => { p.hitsHash = '0' + p.hitsHash.slice(1); },
    trajHash: (p) => { p.trajHash = '0' + p.trajHash.slice(1); },
    fileHash: (p) => { p.fileHash = '0' + p.fileHash.slice(1); },
    rulesHash: (p) => { p.rulesHash = '0' + p.rulesHash.slice(1); },
    lineCount: (p) => { p.lineCount += 1; },
    trajEntryState: (p) => { p.trajectory[0].states = 'f'.repeat(64); },
    trajEntryStart: (p) => { p.trajectory[0].start += 1; },
    trajRemoved: (p) => { p.trajectory.pop(); p.trajHash = p.trajHash; },
  };
  for (const [name, fn] of Object.entries(cases)) {
    assert.throws(() => s.verify(tampered(fn)),
      (e) => e.code === 'PROOF_MISMATCH', `tamper case ${name} must fail`);
  }
});

test('E: proof does not survive file modification (no mtime reliance)', () => {
  const { file, rules } = setup();
  const s = new Session();
  s.load(file, rules);
  const { proof } = s.scan();

  // modify file content, then reload and verify old proof
  fs.appendFileSync(file, JSON.stringify({ lineNo: 4, counterparty: 'D', currency: 'CNY', amount: 1, memo: 'x' }) + '\n');
  const s2 = new Session();
  s2.load(file, rules);
  assert.throws(() => s2.verify(proof), (e) => e.code === 'PROOF_MISMATCH');
});
