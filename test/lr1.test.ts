import test from "node:test";
import assert from "node:assert/strict";
import {
  EPS,
  EOF,
  MAX_PRODUCTIONS,
  parseGrammar,
  computeFirstSets,
  firstOfSequence,
} from "../src/grammar";
import {
  buildCanonicalLR1,
  findConflicts,
  shortestPaths,
  analyzeLalr,
} from "../src/lr1";

const DANGLING_ELSE = `
S -> i S e S
S -> i S
S -> a
`;

const LALR_NOT_LR1 = `
S -> a A d
S -> b B d
S -> a B e
S -> b A e
A -> c
B -> c
`;

const EXPR = `
E -> E + T | T
T -> T * F | F
F -> ( E ) | id
`;

const CC = `
S -> C C
C -> c C
C -> d
`;

test("解析：非终结符/终结符/增广产生式", () => {
  const g = parseGrammar("S -> A b\nA -> a | ε");
  assert.equal(g.start, "S");
  assert.equal(g.productions.length, 4); // 含增广产生式
  assert.equal(g.productions[0].lhs, g.augmentedStart);
  assert.deepEqual(g.productions[0].rhs, ["S"]);
  assert.ok(g.nonterminals.has("A"));
  assert.ok(g.terminals.has("a"));
  assert.ok(g.terminals.has("b"));
  assert.ok(!g.terminals.has("A"));
  // ε 产生式右部为空
  const epsProd = g.productions.find((p) => p.lhs === "A" && p.rhs.length === 0);
  assert.ok(epsProd);
});

test("解析：注释、候选式与 -> ::= → 箭头", () => {
  const g = parseGrammar("# 注释\nS ::= x | y # 行尾注释\nT → z\nS -> T\n");
  assert.equal(g.productions.length, 1 + 2 + 1 + 1);
  assert.ok(g.terminals.has("x"));
  assert.ok(g.terminals.has("z"));
});

test("解析：产生式数量上限", () => {
  const mk = (n: number) =>
    "S -> " + Array.from({ length: n }, (_, i) => `t${i}`).join(" | ");
  assert.doesNotThrow(() => parseGrammar(mk(MAX_PRODUCTIONS)));
  assert.throws(
    () => parseGrammar(mk(MAX_PRODUCTIONS + 1)),
    /超过上限/
  );
});

test("FIRST 集：含 ε 与序列", () => {
  const g = parseGrammar("S -> A B c\nA -> a | ε\nB -> b | ε");
  const first = computeFirstSets(g);
  assert.deepEqual(first.get("A"), new Set([EPS, "a"]));
  assert.deepEqual(first.get("B"), new Set([EPS, "b"]));
  assert.deepEqual(first.get("S"), new Set(["a", "b", "c"]));
  assert.deepEqual(firstOfSequence(["A", "B", "c"], first), new Set(["a", "b", "c"]));
  assert.deepEqual(firstOfSequence([], first), new Set([EPS]));
});

test("规范 LR(1)：S->CC 文法为 10 个状态且无冲突，LALR 合并为 7 个状态", () => {
  const g = parseGrammar(CC);
  const aut = buildCanonicalLR1(g);
  assert.equal(aut.states.length, 10);
  assert.equal(findConflicts(g, aut).length, 0);
  const lalr = analyzeLalr(g, aut);
  assert.equal(lalr.stateCount, 7);
  assert.equal(lalr.conflicts.length, 0);
});

test("悬空 else：恰好 1 个移入-归约冲突，最短符号路径为 i i S", () => {
  const g = parseGrammar(DANGLING_ELSE);
  const aut = buildCanonicalLR1(g);
  const conflicts = findConflicts(g, aut);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.kind, "shift-reduce");
  assert.equal(c.terminal, "e");
  const paths = shortestPaths(aut);
  assert.deepEqual(paths[c.state], ["i", "i", "S"]);
  // 归约产生式为 S -> i S
  assert.equal(c.reduceProds.length, 1);
  assert.deepEqual(g.productions[c.reduceProds[0]].rhs, ["i", "S"]);
  // 沿路径确实能到达冲突状态
  let s = 0;
  for (const sym of paths[c.state]) s = aut.transitions[s].get(sym)!;
  assert.equal(s, c.state);
});

test("LR(1) 但非 LALR(1)：规范 LR(1) 无冲突，合并引入的冲突不算原冲突", () => {
  const g = parseGrammar(LALR_NOT_LR1);
  const aut = buildCanonicalLR1(g);
  // 规范 LR(1)：无冲突
  assert.equal(findConflicts(g, aut).length, 0);
  // LALR 合并后出现归约-归约冲突，且全部标记为合并引入
  const lalr = analyzeLalr(g, aut);
  assert.ok(lalr.conflicts.length > 0);
  assert.ok(lalr.conflicts.every((c) => c.kind === "reduce-reduce"));
  assert.ok(lalr.conflicts.every((c) => c.mergeInduced));
  const terminals = lalr.conflicts.map((c) => c.terminal).sort();
  assert.deepEqual(terminals, ["d", "e"]);
});

test("表达式文法：规范 LR(1) 无冲突", () => {
  const g = parseGrammar(EXPR);
  const aut = buildCanonicalLR1(g);
  assert.equal(findConflicts(g, aut).length, 0);
  const lalr = analyzeLalr(g, aut);
  assert.equal(lalr.conflicts.length, 0);
});

test("最短路径：BFS 覆盖所有状态且路径可达", () => {
  const g = parseGrammar(EXPR);
  const aut = buildCanonicalLR1(g);
  const paths = shortestPaths(aut);
  assert.equal(paths.length, aut.states.length);
  for (let s = 0; s < aut.states.length; s++) {
    let cur = 0;
    for (const sym of paths[s]) {
      const nxt = aut.transitions[cur].get(sym);
      assert.ok(nxt !== undefined, `状态 #${s} 的路径中断`);
      cur = nxt;
    }
    assert.equal(cur, s);
  }
});

test("归约-归约冲突检测", () => {
  // 模糊文法：S -> A | B，A -> x，B -> x 在规范 LR(1) 下即 RR 冲突
  const g = parseGrammar("S -> A\nS -> B\nA -> x\nB -> x");
  const aut = buildCanonicalLR1(g);
  const conflicts = findConflicts(g, aut);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "reduce-reduce");
  assert.equal(conflicts[0].terminal, EOF);
  assert.equal(conflicts[0].reduceProds.length, 2);
});
