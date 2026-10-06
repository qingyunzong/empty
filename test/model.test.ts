import test from "node:test";
import * as assert from "node:assert/strict";
import { parseSpec, SpecError, MAX_STATES } from "../src/model";

function baseSpec(): Record<string, unknown> {
  return {
    alphabet: ["a", "b"],
    automata: [
      { states: ["q0"], initial: "q0", transitions: [] },
      { states: ["p0"], initial: "p0", transitions: [] },
    ],
  };
}

test("accepts a minimal valid spec and sorts the alphabet", () => {
  const spec = parseSpec({ ...baseSpec(), alphabet: ["b", "a", "c"] });
  assert.deepEqual(spec.alphabet, ["a", "b", "c"]);
  assert.equal(spec.automata[0].name, "M1");
  assert.equal(spec.automata[1].name, "M2");
});

test("rejects automata with more than 30 states", () => {
  const spec = baseSpec();
  (spec.automata as { states: string[] }[])[0].states = Array.from({ length: MAX_STATES + 1 }, (_, i) => `s${i}`);
  (spec.automata as { initial: string }[])[0].initial = "s0";
  assert.throws(() => parseSpec(spec), (e: unknown) => e instanceof SpecError && /30-state limit/.test((e as Error).message));
});

test("rejects duplicate transitions (non-deterministic)", () => {
  const spec = baseSpec();
  (spec.automata as object[])[0] = {
    states: ["q0", "q1"],
    initial: "q0",
    transitions: [
      { from: "q0", on: "a", to: "q1" },
      { from: "q0", on: "a", to: "q0" },
    ],
  };
  assert.throws(() => parseSpec(spec), /duplicate transition/);
});

test("rejects unknown symbols, states and registers", () => {
  const s1 = baseSpec();
  (s1.automata as object[])[0] = { states: ["q0"], initial: "q0", transitions: [{ from: "q0", on: "z", to: "q0" }] };
  assert.throws(() => parseSpec(s1), /not in the alphabet/);

  const s2 = baseSpec();
  (s2.automata as object[])[0] = { states: ["q0"], initial: "q0", transitions: [{ from: "q0", on: "a", to: "q9" }] };
  assert.throws(() => parseSpec(s2), /unknown state/);

  const s3 = { ...baseSpec(), registers: ["x"], initialRegisters: { y: 1 } };
  assert.throws(() => parseSpec(s3), /unknown register/);
});

test("rejects non-integer outputs and bad budgets", () => {
  const s1 = baseSpec();
  (s1.automata as object[])[0] = { states: ["q0"], initial: "q0", transitions: [{ from: "q0", on: "a", to: "q0", output: 1.5 }] };
  assert.throws(() => parseSpec(s1), /output must be an integer/);

  const s2 = { ...baseSpec(), stateBudget: 0 };
  assert.throws(() => parseSpec(s2), /stateBudget/);
});

test("requires exactly two automata", () => {
  assert.throws(() => parseSpec({ alphabet: ["a"], automata: [{ states: ["q"], initial: "q" }] }), /exactly two/);
});

test("initial register values are masked to 8 bits", () => {
  const spec = parseSpec({ ...baseSpec(), registers: ["x"], initialRegisters: { x: 300 } });
  assert.deepEqual(spec.initialRegisters, [44]);
});
