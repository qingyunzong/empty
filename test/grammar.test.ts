import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGrammar, GrammarError, type Grammar } from "../src/index.ts";

const base: Grammar = {
  arity: { a: 0, f: 1 },
  nonterminals: ["S"],
  start: "S",
  rules: [
    { id: 0, lhs: "S", symbol: "a", children: [], cost: 1 },
    { id: 1, lhs: "S", symbol: "f", children: ["S"], cost: 2 },
  ],
};

test("a valid grammar passes validation", () => {
  validateGrammar(base);
});

test("negative or non-finite costs are rejected", () => {
  assert.throws(
    () => validateGrammar({ ...base, rules: [{ id: 0, lhs: "S", symbol: "a", children: [], cost: -1 }] }),
    GrammarError,
  );
  assert.throws(
    () => validateGrammar({ ...base, rules: [{ id: 0, lhs: "S", symbol: "a", children: [], cost: NaN }] }),
    GrammarError,
  );
});

test("duplicate rule ids are rejected", () => {
  assert.throws(
    () => validateGrammar({ ...base, rules: [base.rules[0], { ...base.rules[1], id: 0 }] }),
    GrammarError,
  );
});

test("children count must match the symbol arity", () => {
  assert.throws(
    () => validateGrammar({ ...base, rules: [{ id: 0, lhs: "S", symbol: "f", children: [], cost: 1 }] }),
    GrammarError,
  );
});

test("unknown symbols and nonterminals are rejected", () => {
  assert.throws(
    () => validateGrammar({ ...base, rules: [{ id: 0, lhs: "S", symbol: "q", children: [], cost: 1 }] }),
    GrammarError,
  );
  assert.throws(
    () => validateGrammar({ ...base, rules: [{ id: 0, lhs: "S", symbol: "f", children: ["X"], cost: 1 }] }),
    GrammarError,
  );
  assert.throws(() => validateGrammar({ ...base, start: "X" }), GrammarError);
});

test("zero-cost recursive rules are allowed", () => {
  validateGrammar({
    arity: { a: 0, f: 1 },
    nonterminals: ["S"],
    start: "S",
    rules: [
      { id: 0, lhs: "S", symbol: "a", children: [], cost: 0 },
      { id: 1, lhs: "S", symbol: "f", children: ["S"], cost: 0 },
    ],
  });
});
