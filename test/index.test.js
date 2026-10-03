import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PositionalIndex, tokenize } from '../src/index.js';

// 独立枚举实现（不用索引），用于对照
function enumPhrase(docTokens, queryTokens) {
  const hits = [];
  for (let s = 0; s < docTokens.length; s++) {
    let ok = true;
    for (let i = 0; i < queryTokens.length; i++) {
      if (docTokens[s + i] !== queryTokens[i]) { ok = false; break; }
    }
    if (ok) hits.push(s);
  }
  return hits;
}

function enumNear(docTokens, queryTokens, k) {
  const uniq = [...new Set(queryTokens)];
  const hits = [];
  for (let s = 0; s < docTokens.length; s++) {
    if (docTokens[s] !== uniq[0]) continue;
    let end = s;
    let ok = true;
    for (const t of uniq.slice(1)) {
      let found = -1;
      for (let p = s; p <= Math.min(s + k - 1, docTokens.length - 1); p++) {
        if (docTokens[p] === t) { found = p; break; }
      }
      if (found === -1) { ok = false; break; }
      if (found > end) end = found;
    }
    if (ok) hits.push({ start: s, end });
  }
  return hits;
}

const DOCS = {
  d1: '本债券 可提前 赎回 本债券 分期 兑付 利率 固定',
  d2: '提前 赎回 条款 触发 时 本债券 可提前 赎回 全部 份额',
  d3: '浮动 利率 按季 调整 不设 提前 兑付 安排',
  d4: 'callable bond with early redemption option and fixed rate',
};

function buildIndex() {
  const idx = new PositionalIndex();
  for (const [id, text] of Object.entries(DOCS)) idx.addDocument(id, text);
  return idx;
}

test('短语查询结果与枚举窗口一致', () => {
  const idx = buildIndex();
  const queries = ['可提前 赎回', '提前 赎回', '本债券', 'early redemption', '不存在的 词组', 'fixed rate'];
  for (const q of queries) {
    const got = idx.phrase(q);
    const expected = new Map();
    for (const [id, text] of Object.entries(DOCS)) {
      const hits = enumPhrase(tokenize(text), tokenize(q));
      if (hits.length) expected.set(id, hits);
    }
    assert.deepEqual(got, expected, `phrase: ${q}`);
  }
});

test('近邻查询结果与枚举窗口一致', () => {
  const idx = buildIndex();
  const cases = [
    ['提前 赎回', 3],
    ['提前 赎回', 2],
    ['本债券 赎回', 5],
    ['利率 提前', 4],
    ['early redemption', 2],
    ['bond fixed', 6],
    ['提前 赎回', 1], // k 小于词数，必为空
  ];
  for (const [q, k] of cases) {
    const got = idx.near(q, k);
    const expected = new Map();
    for (const [id, text] of Object.entries(DOCS)) {
      const hits = enumNear(tokenize(text), tokenize(q), k);
      if (hits.length) expected.set(id, hits);
    }
    assert.deepEqual(got, expected, `near: ${q} k=${k}`);
  }
});

test('压缩序列化往返一致', () => {
  const idx = buildIndex();
  const restored = PositionalIndex.deserialize(idx.serialize());
  for (const q of ['可提前 赎回', '提前 兑付', 'early redemption']) {
    assert.deepEqual(restored.phrase(q), idx.phrase(q));
  }
  assert.deepEqual(restored.near('提前 赎回', 3), idx.near('提前 赎回', 3));
  assert.equal(restored.docCount(), idx.docCount());
});

test('增量移除位置后查询不再命中', () => {
  const idx = buildIndex();
  idx.removeDocument('d2');
  const phraseHits = idx.phrase('可提前 赎回');
  assert.ok(!phraseHits.has('d2'), '已删除文档不再命中');
  assert.ok(phraseHits.has('d1'), '其他文档不受影响');
  assert.ok(!idx.near('提前 赎回', 3).has('d2'));
  // 其他文档不受影响
  assert.ok(idx.phrase('本债券').has('d1'));
  // 重复移除安全
  idx.removeDocument('d2');
  assert.equal(idx.docCount(), 3);
});
