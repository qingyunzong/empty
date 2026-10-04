import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFsm, canonicalJson } from "../src/fsm.js";

test("parseFsm accepts a well-formed table", () => {
  const fsm = parseFsm({
    initial: "a",
    failureStates: ["bad"],
    transitions: { a: { go: "bad" } },
  });
  assert.equal(fsm.initial, "a");
  assert.ok(fsm.failureStates.has("bad"));
  assert.equal(fsm.transitions.get("a")?.get("go"), "bad");
  assert.ok(fsm.states.has("bad"));
});

test("parseFsm rejects malformed tables", () => {
  const bad: unknown[] = [
    null,
    {},
    { initial: 1, failureStates: [], transitions: {} },
    { initial: "a", failureStates: "x", transitions: {} },
    { initial: "a", failureStates: [], transitions: [] },
    { initial: "a", failureStates: [], transitions: { a: { go: 3 } } },
  ];
  for (const spec of bad) {
    let threw = false;
    try {
      parseFsm(spec);
    } catch {
      threw = true;
    }
    assert.ok(threw, `expected rejection of ${JSON.stringify(spec)}`);
  }
});

test("canonicalJson sorts keys deterministically", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
});
