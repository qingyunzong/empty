import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRule,
  evaluate,
  run,
  RuleSyntaxError,
  RuleEvaluationError,
} from "../src/index.js";

function syntaxError(fn: () => unknown): RuleSyntaxError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RuleSyntaxError, `expected RuleSyntaxError, got ${err}`);
    return err;
  }
  assert.fail("expected RuleSyntaxError");
}

function evalError(fn: () => unknown): RuleEvaluationError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RuleEvaluationError, `expected RuleEvaluationError, got ${err}`);
    return err;
  }
  assert.fail("expected RuleEvaluationError");
}

// ---------- AST reference verification ----------

test("AST reference: simple comparison", () => {
  assert.deepStrictEqual(parseRule("age >= 18"), {
    kind: "Compare",
    op: ">=",
    pos: 4,
    left: { kind: "Field", name: "age", pos: 0 },
    right: { kind: "Number", value: 18n, pos: 7 },
  });
});

test("AST reference: precedence || < && < !", () => {
  // a || b && !c  ==  a || (b && (!c))
  assert.deepStrictEqual(parseRule("a || b && !c"), {
    kind: "Or",
    pos: 2,
    left: { kind: "Field", name: "a", pos: 0 },
    right: {
      kind: "And",
      pos: 7,
      left: { kind: "Field", name: "b", pos: 5 },
      right: {
        kind: "Not",
        pos: 10,
        operand: { kind: "Field", name: "c", pos: 11 },
      },
    },
  });
});

test("AST reference: parentheses override precedence", () => {
  // (a || b) && c
  assert.deepStrictEqual(parseRule("(a || b) && c"), {
    kind: "And",
    pos: 9,
    left: {
      kind: "Or",
      pos: 3,
      left: { kind: "Field", name: "a", pos: 1 },
      right: { kind: "Field", name: "b", pos: 6 },
    },
    right: { kind: "Field", name: "c", pos: 12 },
  });
});

test("AST reference: literals and dotted field", () => {
  // user.age == 30 && ok == true && ref != null
  assert.deepStrictEqual(
    parseRule("user.age == 30 && ok == true && ref != null"),
    {
      kind: "And",
      pos: 29,
      left: {
        kind: "And",
        pos: 15,
        left: {
          kind: "Compare",
          op: "==",
          pos: 9,
          left: { kind: "Field", name: "user.age", pos: 0 },
          right: { kind: "Number", value: 30n, pos: 12 },
        },
        right: {
          kind: "Compare",
          op: "==",
          pos: 21,
          left: { kind: "Field", name: "ok", pos: 18 },
          right: { kind: "Boolean", value: true, pos: 24 },
        },
      },
      right: {
        kind: "Compare",
        op: "!=",
        pos: 36,
        left: { kind: "Field", name: "ref", pos: 32 },
        right: { kind: "Null", pos: 39 },
      },
    }
  );
});

test("AST reference: number literals are bigint", () => {
  const ast = parseRule("n == 9007199254740993");
  assert.equal(ast.kind, "Compare");
  if (ast.kind === "Compare" && ast.right.kind === "Number") {
    assert.equal(typeof ast.right.value, "bigint");
    assert.equal(ast.right.value, 9007199254740993n);
  } else {
    assert.fail("expected Compare with Number right side");
  }
});

// ---------- short-circuit & read order ----------

test("&& short-circuits: right side untouched when left is false", () => {
  const r = run("flag && missing > 0", { flag: false });
  assert.equal(r.value, false);
  assert.deepStrictEqual(r.reads, ["flag"]);
});

test("&& evaluates right side when left is true", () => {
  const err = evalError(() => run("flag && missing > 0", { flag: true }));
  assert.match(err.message, /unknown field 'missing'/);
  assert.equal(err.pos, 8);
});

test("|| short-circuits: right side untouched when left is true", () => {
  const r = run("ok || missing == 1", { ok: true });
  assert.equal(r.value, true);
  assert.deepStrictEqual(r.reads, ["ok"]);
});

test("|| evaluates right side when left is false", () => {
  const r = run("ok || backup", { ok: false, backup: true });
  assert.equal(r.value, true);
  assert.deepStrictEqual(r.reads, ["ok", "backup"]);
});

test("read order follows actual evaluation order", () => {
  const r = run("a && b || c && d", { a: true, b: false, c: true, d: true });
  assert.equal(r.value, true);
  assert.deepStrictEqual(r.reads, ["a", "b", "c", "d"]);

  const r2 = run("a && b || c && d", { a: true, b: false, c: false, d: true });
  assert.equal(r2.value, false);
  assert.deepStrictEqual(r2.reads, ["a", "b", "c"]); // d never read
});

test("resolver function is not called for short-circuited fields", () => {
  const accessed: string[] = [];
  const r = run("a || b", (name) => {
    accessed.push(name);
    if (name === "a") return true;
    throw new Error(`should not access ${name}`);
  });
  assert.equal(r.value, true);
  assert.deepStrictEqual(accessed, ["a"]);
  assert.deepStrictEqual(r.reads, ["a"]);
});

test("! does not short-circuit but negates boolean", () => {
  const r = run("!flag", { flag: false });
  assert.equal(r.value, true);
  assert.deepStrictEqual(r.reads, ["flag"]);
});

// ---------- null comparison rules ----------

test("null allows == and !=", () => {
  assert.equal(run("x == null", { x: null }).value, true);
  assert.equal(run("x != null", { x: null }).value, false);
  assert.equal(run("x == null", { x: 0n }).value, false);
  assert.equal(run("x != null", { x: 0n }).value, true);
  assert.equal(run("null == null", {}).value, true);
});

test("null rejects ordering comparisons", () => {
  for (const op of ["<", "<=", ">", ">="]) {
    const err = evalError(() => run(`x ${op} null`, { x: 1n }));
    assert.match(err.message, /only '==' and '!=' are allowed/);
    const err2 = evalError(() => run(`null ${op} x`, { x: 1n }));
    assert.match(err2.message, /only '==' and '!=' are allowed/);
  }
});

// ---------- bigint & comparisons ----------

test("bigint comparisons keep full precision", () => {
  const r = run("age >= 18 && age < 65", { age: 30n });
  assert.equal(r.value, true);
  assert.deepStrictEqual(r.reads, ["age", "age"]);
  assert.equal(run("n == 9007199254740993", { n: 9007199254740993n }).value, true);
  assert.equal(run("n == 9007199254740993", { n: 9007199254740992n }).value, false);
});

test("string comparisons", () => {
  assert.equal(run('name == "neo"', { name: "neo" }).value, true);
  assert.equal(run("s < 'm'", { s: "abc" }).value, true);
  assert.equal(run("s >= 'm'", { s: "abc" }).value, false);
});

test("mixed-type equality is false, ordering throws", () => {
  assert.equal(run('n == "1"', { n: 1n }).value, false);
  assert.equal(run('n != "1"', { n: 1n }).value, true);
  const err = evalError(() => run('n < "1"', { n: 1n }));
  assert.match(err.message, /cannot compare bigint with string/);
});

test("logical operators require boolean operands", () => {
  assert.match(evalError(() => run("!n", { n: 1n })).message, /expected a boolean/);
  assert.match(evalError(() => run("1 && true", {})).message, /expected a boolean/);
  assert.match(evalError(() => run("flag && 1", { flag: true })).message, /expected a boolean/);
});

test("booleans cannot be ordered", () => {
  assert.match(evalError(() => run("a < b", { a: true, b: false })).message, /cannot order booleans/);
});

// ---------- syntax errors with byte positions ----------

test("syntax error: unexpected end of input", () => {
  const err = syntaxError(() => parseRule("a && "));
  assert.match(err.message, /unexpected end of input/);
  assert.equal(err.pos, 5);
});

test("syntax error: empty input", () => {
  const err = syntaxError(() => parseRule(""));
  assert.equal(err.pos, 0);
});

test("syntax error: unclosed parenthesis", () => {
  const err = syntaxError(() => parseRule("(a || b"));
  assert.match(err.message, /expected '\)'/);
  assert.equal(err.pos, 7);
});

test("syntax error: chained comparison", () => {
  const err = syntaxError(() => parseRule("a < b < c"));
  assert.match(err.message, /chained comparisons/);
  assert.equal(err.pos, 6);
});

test("syntax error: single & and =", () => {
  assert.equal(syntaxError(() => parseRule("a & b")).pos, 2);
  const err = syntaxError(() => parseRule("a = 1"));
  assert.match(err.message, /use '=='/);
  assert.equal(err.pos, 2);
});

test("syntax error: trailing token", () => {
  const err = syntaxError(() => parseRule("a b"));
  assert.equal(err.pos, 2);
});

test("syntax error: decimal literal rejected (numbers are bigint)", () => {
  const err = syntaxError(() => parseRule("x > 1.5"));
  assert.match(err.message, /integer literals/);
  assert.equal(err.pos, 5);
});

test("syntax error: unterminated string", () => {
  const err = syntaxError(() => parseRule("x == 'abc"));
  assert.match(err.message, /unterminated string/);
  assert.equal(err.pos, 5);
});

test("syntax error positions are UTF-8 byte offsets", () => {
  // char index of ')' is 8, but byte offset is 12 ('中'/'文' are 3 bytes each)
  const err = syntaxError(() => parseRule("'中文' && )"));
  assert.match(err.message, /unexpected \)/);
  assert.equal(err.pos, 12);
  assert.match(err.message, /byte 12/);
});

// ---------- evaluate() on a pre-parsed AST ----------

test("evaluate() works on a parsed AST directly", () => {
  const ast = parseRule("!(x == null) && x >= 10");
  assert.equal(evaluate(ast, { x: 20n }).value, true);
  assert.equal(evaluate(ast, { x: 5n }).value, false);
  // x == null short-circuits the && via the negation, no error
  assert.equal(evaluate(ast, { x: null }).value, false);
  const err = evalError(() => evaluate(parseRule("!x"), { x: null }));
  assert.match(err.message, /expected a boolean/);
});
