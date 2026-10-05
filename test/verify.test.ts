import test from "node:test";
import assert from "node:assert/strict";
import { parseGrammar } from "../src/grammar";
import { buildCanonicalLR1, Automaton } from "../src/lr1";
import { verifyPrefixes } from "../src/verify";

const GRAMMARS: Array<[string, string, number]> = [
  ["悬空 else", "S -> i S e S\nS -> i S\nS -> a\n", 3],
  ["表达式", "E -> E + T | T\nT -> T * F | F\nF -> ( E ) | id\n", 4],
  ["S->CC", "S -> C C\nC -> c C\nC -> d\n", 4],
  ["含 ε", "S -> A B\nA -> a A | ε\nB -> b | ε\n", 4],
  ["LR(1) 非 LALR(1)", "S -> a A d\nS -> b B d\nS -> a B e\nS -> b A e\nA -> c\nB -> c\n", 4],
];

for (const [name, text, maxLen] of GRAMMARS) {
  test(`前缀枚举核对通过：${name}（长度 ≤ ${maxLen}）`, () => {
    const g = parseGrammar(text);
    const aut = buildCanonicalLR1(g);
    const res = verifyPrefixes(g, aut, maxLen);
    assert.notEqual(res.status, "truncated", "句型枚举被截断");
    assert.ok(res.prefixCount > 0, "未核对任何前缀");
    assert.deepEqual(res.mismatches, []);
  });
}

test("前缀核对能发现被篡改的项目集", () => {
  const g = parseGrammar("S -> i S e S\nS -> i S\nS -> a\n");
  const aut = buildCanonicalLR1(g);
  // 篡改：从某个多项目状态中删掉一个项目
  const tampered: Automaton = {
    states: aut.states.map((items) => items.slice()),
    transitions: aut.transitions,
  };
  const victim = tampered.states.findIndex((items) => items.length > 2);
  assert.ok(victim >= 0);
  tampered.states[victim] = tampered.states[victim].slice(1);
  const res = verifyPrefixes(g, tampered, 3);
  assert.ok(res.mismatches.length > 0, "篡改后应检出项目集不一致");
});

test("前缀核对能发现缺失的转移", () => {
  const g = parseGrammar("S -> C C\nC -> c C\nC -> d\n");
  const aut = buildCanonicalLR1(g);
  const tampered: Automaton = {
    states: aut.states,
    transitions: aut.transitions.map((m) => new Map(m)),
  };
  // 删除状态 0 的某条转移，使若干前缀不可达
  const sym = [...tampered.transitions[0].keys()][0];
  tampered.transitions[0].delete(sym);
  const res = verifyPrefixes(g, tampered, 2);
  assert.ok(res.mismatches.some((m) => m.includes("无对应路径")));
});
