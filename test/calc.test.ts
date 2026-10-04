import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluate, parse, toSTree, sexpr, evalSTree, Rational } from "../src/index";
import { evalNode } from "../src/eval";

const show = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? `${x}n` : x);

function ok(src: string) {
  const r = evaluate(src);
  assert.ok(r.ok, `expected success for ${JSON.stringify(src)}, got ${show(r)}`);
  return r;
}
function bad(src: string) {
  const r = evaluate(src);
  assert.ok(!r.ok, `expected failure for ${JSON.stringify(src)}, got ${show(r)}`);
  return r.error;
}

describe("exact rational arithmetic", () => {
  test("decimals are exact: 0.1 + 0.2 = 3/10", () => {
    const r = ok("0.1 + 0.2");
    assert.equal(r.value.toString(), "3/10");
    assert.equal(r.display, "3/10");
  });
  test("fractions cancel: 1/3 + 1/6 = 1/2", () => {
    assert.equal(ok("1/3 + 1/6").display, "1/2");
  });
  test("division keeps exact fraction", () => {
    assert.equal(ok("10 / 4").display, "5/2");
  });
  test("Rational.parse round-trips scientific notation", () => {
    assert.equal(Rational.parse("1.5e3").toString(), "1500");
    assert.equal(Rational.parse("2.5e-2").toString(), "1/40");
  });
});

describe("multiplication/division merge dimension vectors", () => {
  test("force times distance is energy", () => {
    const r = ok("3 N * 2 m");
    assert.equal(r.display, "6 kg·m^2/s^2");
    assert.equal(r.unit, "kg·m^2/s^2");
  });
  test("speed", () => {
    assert.equal(ok("10 m / 4 s").display, "5/2 m/s");
  });
  test("unit prefixes scale exactly", () => {
    assert.equal(ok("2 km + 300 m").display, "2300 m");
    assert.equal(ok("1 h / 60").display, "60 s");
    assert.equal(ok("1 L").display, "1/1000 m^3");
  });
  test("powers scale dimension vector", () => {
    assert.equal(ok("2 m^2").display, "2 m^2");
    assert.equal(ok("(2 m)^2").display, "4 m^2");
    assert.equal(ok("1 / s^2").display, "1/s^2");
    assert.equal(ok("m s^-1").display, "m/s");
  });
  test("implicit multiplication", () => {
    assert.equal(ok("3 km").display, "3000 m");
    assert.equal(ok("2 (3 + 4)").display, "14");
  });
  test("same-dimension add/sub keeps unit", () => {
    assert.equal(ok("1 kg + 200 g").display, "6/5 kg");
    assert.equal(ok("0.1 m + 0.2 m").display, "3/10 m");
  });
});

describe("add/sub require matching dimensions; zero is not exempt", () => {
  test("1 m + 1 s reports range and canonical units", () => {
    const e = bad("1 m + 1 s");
    assert.equal(e.leftUnit, "m");
    assert.equal(e.rightUnit, "s");
    assert.deepEqual(e.leftRange, { start: 0, end: 3 });
    assert.deepEqual(e.rightRange, { start: 6, end: 9 });
    assert.equal("1 m + 1 s".slice(e.start, e.end), "1 m + 1 s");
    assert.equal("1 m + 1 s".slice(e.leftRange!.start, e.leftRange!.end), "1 m");
    assert.equal("1 m + 1 s".slice(e.rightRange!.start, e.rightRange!.end), "1 s");
  });
  test("zero does not bypass the dimension check", () => {
    const e1 = bad("0 m + 0 s");
    assert.equal(e1.leftUnit, "m");
    assert.equal(e1.rightUnit, "s");
    const e2 = bad("0 + 0 m");
    assert.equal(e2.leftUnit, "1");
    assert.equal(e2.rightUnit, "m");
  });
  test("zero with matching dimensions is fine", () => {
    assert.equal(ok("0 m + 0 m").display, "0 m");
  });
  test("mismatch inside a larger expression points at the inner node", () => {
    const src = "2 * (1 m + 1 s) + 5";
    const e = bad(src);
    assert.equal(src.slice(e.start, e.end), "1 m + 1 s");
    assert.equal(e.leftUnit, "m");
    assert.equal(e.rightUnit, "s");
  });
});

describe("other errors carry source ranges", () => {
  test("unknown unit", () => {
    const e = bad("1 qq");
    assert.equal("1 qq".slice(e.start, e.end), "qq");
  });
  test("division by zero", () => {
    const e = bad("1 / 0");
    assert.equal("1 / 0".slice(e.start, e.end), "0");
  });
  test("non-integer exponent", () => {
    const e = bad("2 ^ 0.5");
    assert.equal("2 ^ 0.5".slice(e.start, e.end), "0.5");
  });
  test("dimensioned exponent", () => {
    const e = bad("2 ^ (1 m)");
    assert.equal(e.message.includes("dimensionless"), true);
  });
  test("parse error", () => {
    const e = bad("1 +");
    assert.equal(e.message, "unexpected end of input");
  });
});

describe("small syntax tree cross-check", () => {
  test("sexpr rendering", () => {
    assert.equal(ok("1 m + 2 km").sexpr, "(+ (* 1 m) (* 2 km))");
    assert.equal(ok("2 s ^ 2").sexpr, "(* 2 (^ s 2))");
    assert.equal(ok("-3 km / 2").sexpr, "(/ (* (- 3) km) 2)");
  });
  test("tree is JSON-serializable and minimal", () => {
    const r = ok("2 m");
    assert.deepEqual(r.tree, ["bin", "*", ["num", "2"], ["unit", "m"]]);
    JSON.parse(JSON.stringify(r.tree));
  });
  test("independent tree evaluation agrees with AST evaluation", () => {
    const cases = [
      "1 + 2 * 3", "2 km + 300 m", "3 N * 2 m", "10 m / 4 s",
      "(2 m)^2", "1 h / 60", "0.1 m + 0.2 m", "2 (3 + 4)", "1 / s^2",
    ];
    for (const src of cases) {
      const ast = parse(src);
      const a = evalNode(ast);
      const b = evalSTree(JSON.parse(JSON.stringify(toSTree(ast))));
      assert.ok(a.value.equals(b.value), `value mismatch for ${src}`);
      assert.ok(a.dims.every((v, i) => v === b.dims[i]), `dims mismatch for ${src}`);
      assert.equal(ok(src).crossChecked, true);
    }
  });
});
