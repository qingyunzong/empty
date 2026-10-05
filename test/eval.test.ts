import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  bitLength,
  BudgetError,
  CalcError,
  SyntaxError_,
  type Budget,
} from "../src/index.js";

const NO_LIMIT: Budget = { maxSteps: 1_000_000, maxBits: 1_000_000 };

function expectBudgetError(fn: () => void): BudgetError {
  try {
    fn();
  } catch (err) {
    if (err instanceof BudgetError) return err;
    throw err;
  }
  assert.fail("expected a BudgetError");
}

// ---------- exact arithmetic ----------

test("basic arithmetic and precedence", () => {
  assert.equal(evaluate("1 + 2 * 3", NO_LIMIT), 7n);
  assert.equal(evaluate("(1 + 2) * 3", NO_LIMIT), 9n);
  assert.equal(evaluate("2 ** 3 ** 2", NO_LIMIT), 512n); // right-associative
  assert.equal(evaluate("-2 ** 2", NO_LIMIT), -4n); // unary minus binds looser
  assert.equal(evaluate("(-2) ** 2", NO_LIMIT), 4n);
  assert.equal(evaluate("10 - 4 - 3", NO_LIMIT), 3n); // left-associative
  assert.equal(evaluate("--5", NO_LIMIT), 5n);
});

test("arbitrary precision results are exact", () => {
  const src = "2 ** 256 + 2 ** 128 - 1";
  assert.equal(evaluate(src, NO_LIMIT), 2n ** 256n + 2n ** 128n - 1n);
  assert.equal(
    evaluate("12345678901234567890 * 98765432109876543210", NO_LIMIT),
    12345678901234567890n * 98765432109876543210n,
  );
});

test("comparisons and conditionals", () => {
  assert.equal(evaluate("3 < 4", NO_LIMIT), 1n);
  assert.equal(evaluate("3 >= 4", NO_LIMIT), 0n);
  assert.equal(evaluate("2 + 2 == 4", NO_LIMIT), 1n);
  assert.equal(evaluate("2 + 2 != 4", NO_LIMIT), 0n);
  assert.equal(evaluate("1 ? 10 : 20", NO_LIMIT), 10n);
  assert.equal(evaluate("0 ? 10 : 20", NO_LIMIT), 20n);
  assert.equal(evaluate("1 && 2", NO_LIMIT), 1n);
  assert.equal(evaluate("1 && 0", NO_LIMIT), 0n);
  assert.equal(evaluate("0 || 5", NO_LIMIT), 1n);
});

// ---------- cross-check against exact reference interpreter ----------

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

/**
 * Random expression generator that computes the expected value alongside the
 * source text, acting as an exact oracle independent of the library parser.
 */
function genExpr(rand: () => number, depth: number): { src: string; value: bigint } {
  const pick = rand();
  if (depth <= 0 || pick < 0.3) {
    const n = BigInt(Math.floor(rand() * 200) - 100);
    return { src: n < 0n ? `(${n})` : `${n}`, value: n };
  }
  if (pick < 0.45) {
    // small power to keep the oracle cheap
    const base = genExpr(rand, 0);
    const e = BigInt(Math.floor(rand() * 7));
    const b = base.value;
    const value = b === 0n && e === 0n ? 1n : b ** e;
    return { src: `(${base.src}) ** ${e}`, value };
  }
  if (pick < 0.6) {
    const c = genExpr(rand, depth - 1);
    const t = genExpr(rand, depth - 1);
    const f = genExpr(rand, depth - 1);
    return {
      src: `(${c.src}) ? (${t.src}) : (${f.src})`,
      value: c.value !== 0n ? t.value : f.value,
    };
  }
  const l = genExpr(rand, depth - 1);
  const r = genExpr(rand, depth - 1);
  const ops = ["+", "-", "*"] as const;
  const op = ops[Math.floor(rand() * ops.length)]!;
  const value = op === "+" ? l.value + r.value : op === "-" ? l.value - r.value : l.value * r.value;
  return { src: `(${l.src}) ${op} (${r.src})`, value };
}

test("randomized small expressions match exact oracle", () => {
  const rand = mulberry32(20261006);
  for (let i = 0; i < 500; i++) {
    const { src, value } = genExpr(rand, 4);
    assert.equal(evaluate(src, NO_LIMIT), value, `mismatch for ${src}`);
  }
});

// ---------- step budget ----------

test("step budget exceeded reports the failing subexpression range", () => {
  const src = "1 + 2 + 3 + 4";
  const err = expectBudgetError(() => evaluate(src, { maxSteps: 3, maxBits: 1000 }));
  assert.equal(err.kind, "steps");
  assert.equal(err.limit, 3);
  // left-associative: the three '+' nodes consume the budget, evaluation of
  // the leftmost literal '1' is the step that overflows
  assert.equal(src.slice(err.span.start, err.span.end), "1");
  assert.equal(evaluate(src, { maxSteps: 7, maxBits: 1000 }), 10n);
});

// ---------- bit budget ----------

test("oversized literal is rejected with its source range", () => {
  const src = "1 + 340282366920938463463374607431768211456"; // 2^128
  const err = expectBudgetError(() => evaluate(src, { maxSteps: 100, maxBits: 64 }));
  assert.equal(err.kind, "bits");
  assert.equal(err.needed, 129n);
  assert.equal(src.slice(err.span.start, err.span.end), "340282366920938463463374607431768211456");
});

test("multiplication is estimated before execution and error carries the '*' range", () => {
  // maxBits 21 lets each '2 ** 10' through (estimate 2*10=20, exact 11 bits)
  // but not the product, whose estimate is 11 + 11 = 22 bits
  const src = "(2 ** 10) * (2 ** 10)";
  const err = expectBudgetError(() => evaluate(src, { maxSteps: 100, maxBits: 21 }));
  assert.equal(err.kind, "bits");
  assert.equal(err.limit, 21);
  assert.equal(err.estimated, true);
  assert.equal(err.needed, 22n);
  assert.equal(src.slice(err.span.start, err.span.end), src);
  // same expression passes with a sufficient budget
  assert.equal(evaluate(src, { maxSteps: 100, maxBits: 22 }), 2n ** 20n);
});

test("addition result bits are checked exactly", () => {
  const src = "1099511627776 + 1099511627776"; // 2^40 + 2^40 = 2^41, 42 bits
  const err = expectBudgetError(() => evaluate(src, { maxSteps: 100, maxBits: 41 }));
  assert.equal(err.kind, "bits");
  assert.equal(err.estimated, false);
  assert.equal(err.needed, 42n);
  assert.equal(src.slice(err.span.start, err.span.end), src);
  assert.equal(evaluate(src, { maxSteps: 100, maxBits: 42 }), 2n ** 41n);
});

// ---------- huge exponents: deterministic rejection ----------

test("astronomical exponents are rejected reproducibly", () => {
  const src = "7 ** 123456789012345678901234567890";
  const budget: Budget = { maxSteps: 100, maxBits: 128 };
  const errors: BudgetError[] = [];
  for (let i = 0; i < 3; i++) {
    errors.push(expectBudgetError(() => evaluate(src, budget)));
  }
  const first = errors[0]!;
  for (const err of errors.slice(1)) {
    assert.equal(err.message, first.message);
    assert.deepEqual(err.span, first.span);
    assert.equal(err.needed, first.needed);
  }
  assert.equal(first.kind, "bits");
  assert.equal(first.estimated, true);
  // estimate = bitlen(7) * exponent = 3 * 123456789012345678901234567890
  assert.equal(first.needed, 3n * 123456789012345678901234567890n);
  assert.equal(src.slice(first.span.start, first.span.end), src);
});

test("nested huge power is rejected at the inner subexpression", () => {
  const src = "2 ** 10 ** 100";
  const err = expectBudgetError(() => evaluate(src, { maxSteps: 100, maxBits: 128 }));
  assert.equal(err.kind, "bits");
  assert.equal(err.needed, 400n); // bitlen(10) * 100
  assert.equal(src.slice(err.span.start, err.span.end), "10 ** 100");
});

test("negative exponent is a deterministic evaluation error", () => {
  assert.throws(() => evaluate("2 ** (0 - 1)", NO_LIMIT), CalcError);
});

// ---------- short-circuit: unevaluated branches cost nothing ----------

test("short-circuited branches consume no bit budget", () => {
  const budget: Budget = { maxSteps: 1000, maxBits: 64 };
  const huge = "(2 ** 999999999)";
  assert.equal(evaluate(`1 || ${huge}`, budget), 1n);
  assert.equal(evaluate(`0 && ${huge}`, budget), 0n);
  assert.equal(evaluate(`0 ? ${huge} : 42`, budget), 42n);
  assert.equal(evaluate(`1 ? 42 : ${huge}`, budget), 42n);
  // but the same branch fails when actually selected
  assert.throws(() => evaluate(`0 || ${huge}`, budget), BudgetError);
  assert.throws(() => evaluate(`1 && ${huge}`, budget), BudgetError);
  assert.throws(() => evaluate(`1 ? ${huge} : 42`, budget), BudgetError);
});

test("short-circuited branches consume no step budget", () => {
  // nodes actually evaluated: '||' and '1' -> exactly 2 steps
  assert.equal(evaluate("1 || (2 ** 999999999)", { maxSteps: 2, maxBits: 64 }), 1n);
  const err = expectBudgetError(() =>
    evaluate("0 || (2 ** 999999999)", { maxSteps: 2, maxBits: 64 }),
  );
  assert.equal(err.kind, "steps");
});

// ---------- syntax errors ----------

test("syntax errors carry a source range", () => {
  assert.throws(
    () => evaluate("1 + * 2"),
    (err: unknown) => err instanceof SyntaxError_ && err.span.start === 4,
  );
  assert.throws(() => evaluate("(1 + 2"), SyntaxError_);
  assert.throws(() => evaluate("1 2"), SyntaxError_);
});

// ---------- bitLength helper ----------

test("bitLength", () => {
  assert.equal(bitLength(0n), 0);
  assert.equal(bitLength(1n), 1);
  assert.equal(bitLength(-1n), 1);
  assert.equal(bitLength(255n), 8);
  assert.equal(bitLength(256n), 9);
  assert.equal(bitLength(-(2n ** 100n)), 101);
});
