import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { print } from "../src/print.js";
import { ParseError } from "../src/errors.js";
import { lookupUnit } from "../src/units.js";
import { dimsToUnitString } from "../src/dims.js";

test("precedence: * and / bind tighter than + and -", () => {
  assert.equal(print(parse("1+2*3")), "(1 + (2 * 3))");
  assert.equal(print(parse("10/2-3")), "((10 / 2) - 3)");
});

test("implicit multiplication between adjacent primaries", () => {
  assert.equal(print(parse("3 m")), "(3 * m)");
  assert.equal(print(parse("2(1+1)")), "(2 * (1 + 1))");
  assert.equal(print(parse("N m")), "(N * m)");
});

test("power binds to the preceding primary; unary minus stays outside", () => {
  assert.equal(print(parse("m^2")), "(m)^2");
  assert.equal(print(parse("s^-1")), "(s)^-1");
  assert.equal(print(parse("-m^2")), "(-(m)^2)");
  assert.equal(print(parse("2 m^2")), "(2 * (m)^2)");
});

test("parentheses override precedence and extend the range", () => {
  const ast = parse("(1+2)*3");
  assert.equal(ast.start, 0);
  assert.equal(ast.end, 7);
  assert.equal(print(ast), "((1 + 2) * 3)");
});

test("node ranges point back into the source", () => {
  const src = "12 m + 4 s";
  const ast = parse(src);
  assert.equal(ast.start, 0);
  assert.equal(ast.end, src.length);
  if (ast.kind !== "bin") throw new Error("expected bin");
  assert.equal(src.slice(ast.left.start, ast.left.end), "12 m");
  assert.equal(src.slice(ast.right.start, ast.right.end), "4 s");
});

test("parse errors carry a source range", () => {
  assert.throws(
    () => parse("1 +"),
    (e: unknown) => e instanceof ParseError && e.start === 3,
  );
  assert.throws(
    () => parse("3 quux"),
    (e: unknown) =>
      e instanceof ParseError && e.start === 2 && e.end === 6 &&
      /unknown unit 'quux'/.test(e.message),
  );
  assert.throws(() => parse("m^2.5"), ParseError);
  assert.throws(() => parse("1 @ 2"), ParseError);
});

test("unit table: exact, prefixed, and derived units", () => {
  const km = lookupUnit("km");
  assert.ok(km);
  assert.equal(km.scale.toString(), "1000");
  assert.equal(dimsToUnitString(km.dims), "m");

  const mg = lookupUnit("mg");
  assert.ok(mg);
  assert.equal(mg.scale.toString(), "1/1000000");
  assert.equal(dimsToUnitString(mg.dims), "kg");

  const newton = lookupUnit("N");
  assert.ok(newton);
  assert.equal(dimsToUnitString(newton.dims), "kg*m*s^-2");

  const hour = lookupUnit("h");
  assert.ok(hour);
  assert.equal(hour.scale.toString(), "3600");

  assert.equal(lookupUnit("quux"), undefined);
});
