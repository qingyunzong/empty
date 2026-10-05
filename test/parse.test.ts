import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSequence,
  parseTree,
  decodeSequence,
  verifyCertificate,
  SequenceError,
  type Grammar,
} from "../src/index.ts";

// Ambiguous grammar: S -> a (10) | f(A,A) (1); A -> a (2) | b (3)
const AMBIGUOUS: Grammar = {
  arity: { a: 0, b: 0, f: 2 },
  nonterminals: ["S", "A"],
  start: "S",
  rules: [
    { id: 0, lhs: "S", symbol: "a", children: [], cost: 10 },
    { id: 1, lhs: "S", symbol: "f", children: ["A", "A"], cost: 1 },
    { id: 2, lhs: "A", symbol: "a", children: [], cost: 2 },
    { id: 3, lhs: "A", symbol: "b", children: [], cost: 3 },
  ],
};

// Recursive grammar: S -> f(S) (2) | a (5)
const RECURSIVE: Grammar = {
  arity: { a: 0, f: 1 },
  nonterminals: ["S"],
  start: "S",
  rules: [
    { id: 0, lhs: "S", symbol: "f", children: ["S"], cost: 2 },
    { id: 1, lhs: "S", symbol: "a", children: [], cost: 5 },
  ],
};

test("picks the cheapest derivation among ambiguous ones", () => {
  const result = parseSequence(AMBIGUOUS, ["f", "a", "b"]);
  assert.equal(result.status, "optimal");
  assert.equal(result.cost, 6); // 1 + 2 + 3
  assert.deepEqual(result.certificate?.ruleIds, [1, 2, 3]);
});

test("ambiguous leaf: cheaper rule wins and rule id sequence reflects it", () => {
  const cheaper: Grammar = {
    arity: { a: 0 },
    nonterminals: ["S"],
    start: "S",
    rules: [
      { id: 7, lhs: "S", symbol: "a", children: [], cost: 9 },
      { id: 3, lhs: "S", symbol: "a", children: [], cost: 4 },
    ],
  };
  const result = parseSequence(cheaper, ["a"]);
  assert.equal(result.cost, 4);
  assert.deepEqual(result.certificate?.ruleIds, [3]);
});

test("recursive rules: cost accumulates along the spine", () => {
  const result = parseSequence(RECURSIVE, ["f", "f", "a"]);
  assert.equal(result.status, "optimal");
  assert.equal(result.cost, 9); // 2 + 2 + 5
  assert.deepEqual(result.certificate?.ruleIds, [0, 0, 1]);
});

test("infeasible: no rule covers an input symbol", () => {
  const result = parseSequence(RECURSIVE, ["f", "f", "f", "a"]);
  assert.equal(result.status, "optimal"); // recursion of any depth is fine
  const noBase: Grammar = {
    arity: { a: 0, f: 1 },
    nonterminals: ["S"],
    start: "S",
    rules: [{ id: 0, lhs: "S", symbol: "f", children: ["S"], cost: 1 }],
  };
  const missing = parseSequence(noBase, ["f", "a"]);
  assert.equal(missing.status, "infeasible");
  assert.equal(missing.cost, null);
  assert.equal(missing.certificate, null);
});

test("infeasible is distinguished from malformed input", () => {
  assert.throws(() => parseSequence(RECURSIVE, ["f"]), SequenceError);
  const result = parseSequence(RECURSIVE, ["a"]);
  assert.equal(result.status, "optimal");
});

test("budget: optimal at or under budget, over-budget above it, never confused with infeasible", () => {
  const at = parseSequence(RECURSIVE, ["f", "a"], { budget: 7 });
  assert.equal(at.status, "optimal");
  assert.equal(at.cost, 7);

  const over = parseSequence(RECURSIVE, ["f", "a"], { budget: 6 });
  assert.equal(over.status, "over-budget");
  assert.equal(over.cost, 7); // optimum still reported as evidence
  assert.deepEqual(over.certificate?.ruleIds, [0, 1]);

  const infeasible: Grammar = { ...RECURSIVE, rules: [RECURSIVE.rules[0]] };
  const none = parseSequence(infeasible, ["a"], { budget: 100 });
  assert.equal(none.status, "infeasible");
});

test("negative budget is rejected", () => {
  assert.throws(() => parseSequence(RECURSIVE, ["a"], { budget: -1 }), RangeError);
});

test("zero-cost rules yield a zero-cost optimum", () => {
  const free: Grammar = {
    arity: { a: 0, f: 1 },
    nonterminals: ["S"],
    start: "S",
    rules: [
      { id: 0, lhs: "S", symbol: "a", children: [], cost: 0 },
      { id: 1, lhs: "S", symbol: "f", children: ["S"], cost: 0 },
    ],
  };
  const result = parseSequence(free, ["f", "f", "f", "a"]);
  assert.equal(result.status, "optimal");
  assert.equal(result.cost, 0);
});

test("parseTree and parseSequence agree; certificate verifies", () => {
  const seq = ["f", "f", "a"];
  const viaSeq = parseSequence(RECURSIVE, seq);
  const viaTree = parseTree(RECURSIVE, decodeSequence(seq, RECURSIVE.arity));
  assert.equal(viaSeq.cost, viaTree.cost);
  assert.deepEqual(viaSeq.certificate, viaTree.certificate);
  assert.ok(viaSeq.certificate);
  assert.deepEqual(verifyCertificate(RECURSIVE, viaSeq.tree, viaSeq.certificate), { ok: true });
});
