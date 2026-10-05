import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSequence, encodeSequence, tree, treeSize, SequenceError } from "../src/index.ts";

const ARITY: Record<string, number> = { a: 0, b: 0, f: 1, g: 2 };

test("decodeSequence parses a prefix sequence into the unique ranked tree", () => {
  const t = decodeSequence(["g", "f", "a", "b"], ARITY);
  assert.deepEqual(t, tree("g", tree("f", tree("a")), tree("b")));
  assert.equal(treeSize(t), 4);
});

test("encodeSequence is the exact inverse of decodeSequence", () => {
  const seq = ["g", "f", "a", "g", "b", "a"];
  assert.deepEqual(encodeSequence(decodeSequence(seq, ARITY)), seq);
});

test("decodeSequence rejects an unknown symbol", () => {
  assert.throws(() => decodeSequence(["f", "zzz"], ARITY), SequenceError);
});

test("decodeSequence rejects a truncated sequence", () => {
  assert.throws(() => decodeSequence(["g", "a"], ARITY), SequenceError);
  assert.throws(() => decodeSequence([], ARITY), SequenceError);
});

test("decodeSequence rejects trailing tokens after a complete tree", () => {
  assert.throws(() => decodeSequence(["a", "b"], ARITY), SequenceError);
});
