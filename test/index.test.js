import test from 'node:test';
import assert from 'node:assert/strict';
import { Index } from '../src/index.js';
import { brutePhrase, bruteTerm, bruteNear } from '../test-helpers/brute.js';

// Maintenance work-order notes corpus.
const CORPUS = [
  { id: 'WO-1001', version: 1, text: '巡检发现3号泵轴承过热，立即停机' },
  { id: 'WO-1002', version: 1, text: '轴承润滑正常，无过热现象' },
  { id: 'WO-1003', version: 1, text: '更换轴承；过热报警已复位' },
  { id: 'WO-1004', version: 1, text: '轴承与过热保护装置联动测试' },
  { id: 'WO-1005', version: 1, text: '过热后轴承间隙复测合格' },
  { id: 'WO-1006', version: 1, text: '轴承温度正常' },
  { id: 'WO-1007', version: 1, text: 'Pump2 bearing overheated, pump2 shut down' },
  { id: 'WO-1007', version: 2, text: 'Pump2 轴承 过热 复查，过热 过热 未再现' },
];

function buildIndex(docs) {
  const index = new Index();
  for (const doc of docs) index.addText(Index.docKey(doc.id, doc.version), doc.text);
  return index;
}

test('acceptance 1: phrase results match brute-force scan exactly', () => {
  const index = buildIndex(CORPUS);
  for (const phrase of ['轴承 过热', '过热 轴承', '轴承', '过热 过热', '轴承 过热 报警', '不存在的词']) {
    assert.deepEqual(index.queryPhrase(phrase), brutePhrase(CORPUS, phrase), `phrase: ${phrase}`);
  }
});

test('acceptance 1: term results match brute-force scan exactly', () => {
  const index = buildIndex(CORPUS);
  for (const term of ['轴承', '过热', '泵', 'pump2', 'PUMP2', '3']) {
    assert.deepEqual(index.queryTerm(term), bruteTerm(CORPUS, term), `term: ${term}`);
  }
});

test('acceptance 1: NEAR/k results match brute-force scan for k = 0..6', () => {
  const index = buildIndex(CORPUS);
  for (let k = 0; k <= 6; k += 1) {
    assert.deepEqual(index.queryNear('轴承', '过热', k), bruteNear(CORPUS, '轴承', '过热', k), `near k=${k}`);
    assert.deepEqual(index.queryNear('过热', '轴承', k), bruteNear(CORPUS, '过热', '轴承', k), `near reversed k=${k}`);
  }
});

test('acceptance 1: tie ordering is deterministic (id asc, version asc)', () => {
  const index = buildIndex(CORPUS);
  const results = index.queryPhrase('轴承 过热');
  const ids = results.map((r) => `${r.id}#${r.version}`);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(
    results.map((r) => [r.id, r.version]),
    brutePhrase(CORPUS, '轴承 过热').map((r) => [r.id, r.version]),
  );
});

test('phrase spans punctuation but not intervening tokens', () => {
  const index = buildIndex(CORPUS);
  const hits = index.queryPhrase('轴承 过热').map((r) => r.id);
  assert.ok(hits.includes('WO-1003')); // 更换轴承；过热 — punctuation is a separator
  assert.ok(!hits.includes('WO-1004')); // 轴承与过热 — token 与 in between
  assert.ok(!hits.includes('WO-1005')); // reversed order
});

test('query errors use E_PARSE', () => {
  const index = buildIndex(CORPUS);
  assert.throws(() => index.queryPhrase('   '), /E_PARSE|no searchable|empty/);
  assert.throws(() => index.queryNear('轴承', '过热', -1));
  assert.throws(() => index.queryTerm('！！'));
});
