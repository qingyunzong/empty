'use strict';

// 验收A：重叠命中按 (起始位置, 长度, 规则id) 统一排序返回。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAutomata, scanLine, cmpHits } = require('../src/scanner');

test('A: overlapping hits returned in unified (start, length, ruleId) order', () => {
  const rules = [
    { id: 'E1', type: 'exact', pattern: 'abc' },
    { id: 'E2', type: 'exact', pattern: 'bc' },
    { id: 'E3', type: 'exact', pattern: 'c' },
    { id: 'R1', type: 'regex', pattern: 'a.c' },
    { id: 'R2', type: 'regex', pattern: 'b.' },
  ];
  const automata = buildAutomata(rules);
  const hits = scanLine('abc', automata);

  // All expected overlapping hits are present.
  const keys = hits.map((h) => `${h.kind}:${h.ruleId}@${h.start}-${h.end}`);
  assert.deepEqual(keys.sort(), [
    'exact:E1@0-3', 'exact:E2@1-3', 'exact:E3@2-3',
    'regex:R1@0-3', 'regex:R2@1-3',
  ].sort());

  // Sequence is sorted by (start, length, ruleId).
  for (let i = 1; i < hits.length; i++) {
    assert.ok(cmpHits(hits[i - 1], hits[i]) < 0,
      `out of order at ${i}: ${JSON.stringify(hits[i - 1])} vs ${JSON.stringify(hits[i])}`);
  }
  // Exact expected order: start 0 (E1 len3, R1 len3 -> ruleId asc), then start 1
  // (E2 len2, R2 len2 -> ruleId asc), then start 2 (E3).
  assert.deepEqual(hits.map((h) => h.ruleId), ['E1', 'R1', 'E2', 'R2', 'E3']);
});

test('A: longer text, ordering holds across many overlaps', () => {
  const rules = [
    { id: 'E1', type: 'exact', pattern: 'aa' },
    { id: 'E2', type: 'exact', pattern: 'aaa' },
    { id: 'R1', type: 'regex', pattern: 'a+' },
  ];
  const hits = scanLine('aaaa', buildAutomata(rules));
  for (let i = 1; i < hits.length; i++) {
    assert.ok(cmpHits(hits[i - 1], hits[i]) < 0);
  }
  // spot check: at start 0, lengths 1..4 interleave exact/regex by (length, ruleId)
  assert.deepEqual(hits.slice(0, 6).map((h) => [h.ruleId, h.start, h.end]), [
    ['R1', 0, 1], ['E1', 0, 2], ['R1', 0, 2], ['E2', 0, 3], ['R1', 0, 3], ['R1', 0, 4],
  ]);
});
