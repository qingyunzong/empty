import test from "node:test";
import * as assert from "node:assert/strict";
import { parseExpr, toByte } from "../src/expr";

test("evaluates constants and variables", () => {
  assert.equal(parseExpr("42").eval({}), 42);
  assert.equal(parseExpr("x").eval({ x: 7 }), 7);
  assert.equal(parseExpr("x + y").eval({ x: 3, y: 4 }), 7);
});

test("respects precedence and parentheses", () => {
  assert.equal(parseExpr("2 + 3 * 4").eval({}), 14);
  assert.equal(parseExpr("(2 + 3) * 4").eval({}), 20);
  assert.equal(parseExpr("x * 2 + 1").eval({ x: 10 }), 21);
});

test("unary minus, truncating division, modulo", () => {
  assert.equal(parseExpr("-x").eval({ x: 5 }), -5);
  assert.equal(parseExpr("- (x + 1)").eval({ x: 2 }), -3);
  assert.equal(parseExpr("7 / 2").eval({}), 3);
  assert.equal(parseExpr("-7 / 2").eval({}), -3);
  assert.equal(parseExpr("7 % 3").eval({}), 1);
});

test("reports referenced variables", () => {
  assert.deepEqual(parseExpr("x + y * 2").vars.sort(), ["x", "y"]);
  assert.deepEqual(parseExpr("5").vars, []);
});

test("throws on division by zero and unknown register", () => {
  assert.throws(() => parseExpr("1 / 0").eval({}), /division by zero/);
  assert.throws(() => parseExpr("1 % 0").eval({}), /modulo by zero/);
  assert.throws(() => parseExpr("nope").eval({}), /unknown register/);
});

test("throws on malformed expressions", () => {
  assert.throws(() => parseExpr("1 +"), /unexpected end/);
  assert.throws(() => parseExpr("1 2"), /trailing tokens/);
  assert.throws(() => parseExpr("(1"), /missing '\)'/);
  assert.throws(() => parseExpr("a & b"), /unexpected character/);
});

test("toByte masks to unsigned 8 bits", () => {
  assert.equal(toByte(0), 0);
  assert.equal(toByte(255), 255);
  assert.equal(toByte(256), 0);
  assert.equal(toByte(-1), 255);
  assert.equal(toByte(300), 44);
});
