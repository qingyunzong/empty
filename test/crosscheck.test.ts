/**
 * Cross-checks the DP parser against exhaustive enumeration on small grammars:
 *   1. random small grammars x random input trees: DP cost === brute-force cost
 *      (including agreement on infeasibility), and every certificate verifies;
 *   2. bounded-tree enumeration: every tree a grammar derives within a depth
 *      bound parses as "optimal", matches brute force, and verifies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTree,
  bruteForceMinCost,
  enumerateTrees,
  validateGrammar,
  verifyCertificate,
  type Grammar,
  type Rule,
  type Tree,
} from "../src/index.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGrammar(rand: () => number): Grammar {
  const nonterminals = ["S", "A", "B"].slice(0, 1 + Math.floor(rand() * 3));
  const arity: Record<string, number> = {
    a: 0,
    b: 0,
    f: 1 + Math.floor(rand() * 2), // unary or binary
    g: Math.floor(rand() * 3), // 0..2
  };
  const symbols = Object.keys(arity);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const rules: Rule[] = [];
  let id = 0;
  for (const lhs of nonterminals) {
    const ruleCount = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < ruleCount; i += 1) {
      const symbol = pick(symbols);
      const children = Array.from({ length: arity[symbol] }, () => pick(nonterminals));
      rules.push({ id: id++, lhs, symbol, children, cost: Math.floor(rand() * 6) });
    }
  }
  const grammar: Grammar = { arity, nonterminals, start: "S", rules };
  validateGrammar(grammar);
  return grammar;
}

function randomTree(rand: () => number, arity: Record<string, number>, maxDepth: number): Tree {
  const leaves = Object.keys(arity).filter((s) => arity[s] === 0);
  const all = Object.keys(arity);
  const symbol = maxDepth <= 0 ? leaves[Math.floor(rand() * leaves.length)] : all[Math.floor(rand() * all.length)];
  const children = Array.from({ length: arity[symbol] }, () => randomTree(rand, arity, maxDepth - 1));
  return { symbol, children };
}

test("DP matches exhaustive enumeration on 400 random small instances", () => {
  const rand = mulberry32(20261006);
  let feasible = 0;
  let infeasible = 0;
  for (let instance = 0; instance < 400; instance += 1) {
    const grammar = randomGrammar(rand);
    const input = randomTree(rand, grammar.arity, 3);

    const dp = parseTree(grammar, input);
    const brute = bruteForceMinCost(grammar, input, 500_000);
    assert.ok(!brute.capped, "brute force cap must not be hit in this test");

    assert.equal(dp.cost, brute.cost, `cost mismatch on instance ${instance}`);
    if (dp.cost === null) {
      infeasible += 1;
      assert.equal(dp.status, "infeasible");
      assert.equal(dp.certificate, null);
    } else {
      feasible += 1;
      assert.equal(dp.status, "optimal");
      assert.ok(dp.certificate);
      assert.deepEqual(verifyCertificate(grammar, input, dp.certificate), { ok: true });
      assert.equal(dp.certificate.ruleIds.length, countNodes(input));
    }
  }
  assert.ok(feasible > 0 && infeasible > 0, `want both outcomes, got ${feasible}/${infeasible}`);
});

test("budget never changes feasibility, only the status label", () => {
  const rand = mulberry32(7);
  for (let instance = 0; instance < 100; instance += 1) {
    const grammar = randomGrammar(rand);
    const input = randomTree(rand, grammar.arity, 2);
    const free = parseTree(grammar, input);
    const budget = Math.floor(rand() * 8);
    const bounded = parseTree(grammar, input, { budget });
    assert.equal(bounded.cost, free.cost);
    if (free.cost === null) assert.equal(bounded.status, "infeasible");
    else if (free.cost > budget) assert.equal(bounded.status, "over-budget");
    else assert.equal(bounded.status, "optimal");
  }
});

test("every tree a small grammar derives (depth-bounded) parses optimally and verifies", () => {
  const grammars: Grammar[] = [
    {
      arity: { a: 0, b: 0, f: 1, g: 2 },
      nonterminals: ["S", "A"],
      start: "S",
      rules: [
        { id: 0, lhs: "S", symbol: "g", children: ["S", "A"], cost: 1 },
        { id: 1, lhs: "S", symbol: "f", children: ["S"], cost: 2 },
        { id: 2, lhs: "S", symbol: "a", children: [], cost: 3 },
        { id: 3, lhs: "A", symbol: "b", children: [], cost: 4 },
        { id: 4, lhs: "A", symbol: "a", children: [], cost: 1 },
      ],
    },
    {
      arity: { a: 0, f: 1, g: 2 },
      nonterminals: ["S"],
      start: "S",
      rules: [
        { id: 0, lhs: "S", symbol: "g", children: ["S", "S"], cost: 0 },
        { id: 1, lhs: "S", symbol: "f", children: ["S"], cost: 1 },
        { id: 2, lhs: "S", symbol: "a", children: [], cost: 2 },
      ],
    },
  ];
  for (const grammar of grammars) {
    const trees = enumerateTrees(grammar, 3, 2_000);
    assert.ok(trees.length > 10, "enumeration should produce a meaningful sample");
    for (const input of trees) {
      const dp = parseTree(grammar, input);
      assert.equal(dp.status, "optimal", "a derivable tree must be feasible");
      const brute = bruteForceMinCost(grammar, input, 500_000);
      assert.ok(!brute.capped);
      assert.equal(dp.cost, brute.cost);
      assert.ok(dp.certificate);
      assert.deepEqual(verifyCertificate(grammar, input, dp.certificate), { ok: true });
    }
  }
});

function countNodes(t: Tree): number {
  return 1 + t.children.reduce((sum, child) => sum + countNodes(child), 0);
}
