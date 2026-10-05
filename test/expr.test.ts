import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import {
  evalNaive,
  fullMask,
  maskOf,
  parseExpr,
  varMask,
  varsOf,
  type Expr,
} from "../src/expr.js";
import { firstCombination, nextCombination, binomial } from "../src/combo.js";

test("parser respects precedence: ! & | ^ -> <->", () => {
  const env = (name: string) => name === "a";
  equal(evalNaive(parseExpr("!a | a"), env), true); // (!a) | a
  equal(evalNaive(parseExpr("a | b & c"), () => false), false); // a | (b & c)
  equal(evalNaive(parseExpr("a -> b -> c"), () => false), true); // a -> (b -> c)
  equal(evalNaive(parseExpr("a <-> b | c"), () => false), true); // a <-> (b | c)
});

test("parser handles keywords, constants and parentheses", () => {
  equal(evalNaive(parseExpr("true and not false"), () => false), true);
  equal(evalNaive(parseExpr("(a or b) and !(a and b)"), (n) => n === "a"), true);
  equal(evalNaive(parseExpr("1 xor 1"), () => false), false);
  equal(evalNaive(parseExpr("a implies b"), (n) => n === "a"), false);
});

test("parser rejects malformed input", () => {
  throws(() => parseExpr("a &"), /unexpected end/);
  throws(() => parseExpr("(a | b"), /closing parenthesis/);
  throws(() => parseExpr("a b"), /trailing tokens/);
  throws(() => parseExpr("a $ b"), /unexpected character/);
});

test("varsOf returns sorted unique variables", () => {
  deep(varsOf(parseExpr("b & a | b -> c")), ["a", "b", "c"]);
  deep(varsOf(parseExpr("true")), []);
});

function deep(actual: unknown, expected: unknown): void {
  equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("varMask and fullMask match naive bit patterns", () => {
  const n = 4;
  equal(fullMask(n), (1n << 16n) - 1n);
  for (let j = 0; j < n; j++) {
    const mask = varMask(j, n);
    for (let a = 0; a < 1 << n; a++) {
      const bit = (mask >> BigInt(a)) & 1n;
      const expected = BigInt((a >> (n - 1 - j)) & 1);
      equal(bit, expected, `var ${j} assignment ${a}`);
    }
  }
});

// Deterministic PRNG so the cross-check is reproducible.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

}

function randomExpr(rand: () => number, vars: string[], depth: number): Expr {
  if (depth === 0 || rand() < 0.3) {
    if (rand() < 0.2) return { kind: "const", value: rand() < 0.5 };
    return { kind: "var", name: vars[Math.floor(rand() * vars.length)] };
    }
  const choice = Math.floor(rand() * 7);
  if (choice === 0) return { kind: "not", arg: randomExpr(rand, vars, depth - 1) };
  const kinds = ["and", "or", "xor", "imp", "iff"] as const;
  const kind = kinds[(choice - 1) % kinds.length];
  return {
    kind,
    left: randomExpr(rand, vars, depth - 1),
    right: randomExpr(rand, vars, depth - 1),
  };
}

test("mask evaluator matches naive evaluator on 300 random expressions", () => {
  const rand = mulberry32(20261005);
  const vars = ["p", "q", "r", "s"];
  const n = vars.length;
  const index = new Map(vars.map((v, i) => [v, i]));
  for (let iter = 0; iter < 300; iter++) {
    const expr = randomExpr(rand, vars, 3);
    const mask = maskOf(expr, vars);
    for (let a = 0; a < 1 << n; a++) {
      const naive = evalNaive(expr, (name) => Boolean((a >> (n - 1 - index.get(name)!)) & 1));
      const masked = Boolean((mask >> BigInt(a)) & 1n);
      equal(masked, naive, `iteration ${iter} assignment ${a}`);
    }
  }
});

test("combinations enumerate in lexicographic order and cover C(n,k)", () => {
  const seen: string[] = [];
  let combo: number[] | null = firstCombination(2);
  while (combo !== null) {
    seen.push(combo.join(","));
    combo = nextCombination(combo, 4);
  }
  deep(seen, ["0,1", "0,2", "0,3", "1,2", "1,3", "2,3"]);
  equal(seen.length, binomial(4, 2));
  equal(binomial(18, 9), 48620);
});

test("a combination can be paused and resumed mid-enumeration", () => {
  const all: string[] = [];
  let combo: number[] | null = firstCombination(3);
  while (combo !== null) {
    all.push(combo.join(","));
    combo = nextCombination(combo, 5);
  }
  const resumeFrom = all[5].split(",").map(Number);
  const tail: string[] = [];
  let cursor: number[] | null = resumeFrom;
  while (cursor !== null) {
    tail.push(cursor.join(","));
    cursor = nextCombination(cursor, 5);
  }
  deep(tail, all.slice(5));
  ok(all.length === binomial(5, 3));
});
