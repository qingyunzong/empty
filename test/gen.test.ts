import test from "node:test";
import * as assert from "node:assert/strict";
import { Rng } from "../src/rng";
import { integer, arrayOf, constant, map, oneOf, boolean } from "../src/gen";

test("integer generates within bounds", () => {
  const rng = new Rng(2024);
  const gen = integer(10, 20);
  for (let i = 0; i < 200; i++) {
    const v = gen(rng, i).value;
    assert.ok(v >= 10 && v <= 20);
  }
});

test("constant ignores the rng entirely", () => {
  const gen = constant("hello");
  const a = gen(new Rng(1), 0).value;
  const b = gen(new Rng(999999), 50).value;
  assert.equal(a, "hello");
  assert.equal(b, "hello");
});

test("arrayOf respects length bounds", () => {
  const rng = new Rng(5);
  const gen = arrayOf(integer(0, 9), { minLength: 2, maxLength: 6 });
  for (let i = 0; i < 200; i++) {
    const v = gen(rng, i).value;
    assert.ok(v.length >= 2 && v.length <= 6, `length ${v.length}`);
  }
});

test("map transforms values", () => {
  const gen = map(integer(1, 1), (n) => n * 10);
  assert.equal(gen(new Rng(0), 0).value, 10);
});

test("oneOf only produces values from its generators", () => {
  const rng = new Rng(77);
  const gen = oneOf(constant("a"), constant("b"), constant("c"));
  for (let i = 0; i < 100; i++) {
    assert.ok(["a", "b", "c"].includes(gen(rng, i).value));
  }
});

test("boolean shrinks true towards false", () => {
  const gen = boolean();
  const rng = new Rng(0);
  let sawTrueShrink = false;
  for (let i = 0; i < 50; i++) {
    const tree = gen(rng, i);
    if (tree.value === true) {
      const kids = [...tree.shrinks()];
      assert.equal(kids.length, 1);
      assert.equal(kids[0]!.value, false);
      sawTrueShrink = true;
    }
  }
  assert.ok(sawTrueShrink);
});
