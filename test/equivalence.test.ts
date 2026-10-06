import test from "node:test";
import * as assert from "node:assert/strict";
import { parseSpec, Spec } from "../src/model";
import { Machine, SINK_STATE } from "../src/machine";
import { checkEquivalence } from "../src/equivalence";
import { verifyByEnumeration } from "../src/enumerate";

function build(raw: Spec) {
  const spec = parseSpec(raw);
  const m1 = new Machine(spec.automata[0], spec.alphabet, spec.registers);
  const m2 = new Machine(spec.automata[1], spec.alphabet, spec.registers);
  return { spec, m1, m2 };
}

test("identical automata are equivalent and yield a certificate", () => {
  const auto = {
    states: ["q0", "q1"],
    initial: "q0",
    accepting: ["q1"],
    transitions: [
      { from: "q0", on: "a", to: "q1", output: 1 },
      { from: "q1", on: "a", to: "q1", output: 2 },
      { from: "q1", on: "b", to: "q0", output: 0 },
    ],
  };
  const { spec, m1, m2 } = build({ alphabet: ["a", "b"], automata: [auto, { ...auto, name: "B" }] });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "equivalent");
  if (res.status !== "equivalent") return;
  assert.ok(res.certificate.reachableConfigurations >= 2);
  assert.equal(res.certificate.registerBits, 8);
  assert.ok(res.certificate.configurations.length >= 1);

  const report = verifyByEnumeration(m1, m2, spec.initialRegisters, 100000);
  assert.equal(report.ok, true);
  assert.ok(report.checkedWords > 100);
});

test("finds the lexicographically smallest among shortest distinguishing words", () => {
  // A accepts exactly the words "ab" and "ba" (length-2 distinguishers);
  // B loops with identical (null) outputs and accepts nothing. The shortest
  // distinguishing words are "ab" and "ba"; the answer must be "ab".
  const a = {
    name: "A",
    states: ["q0", "q1", "q2", "qA"],
    initial: "q0",
    accepting: ["qA"],
    transitions: [
      { from: "q0", on: "a", to: "q1", output: null },
      { from: "q0", on: "b", to: "q2", output: null },
      { from: "q1", on: "b", to: "qA", output: null },
      { from: "q2", on: "a", to: "qA", output: null },
    ],
  };
  const b = {
    name: "B",
    states: ["p0"],
    initial: "p0",
    accepting: [],
    transitions: [
      { from: "p0", on: "a", to: "p0", output: null },
      { from: "p0", on: "b", to: "p0", output: null },
    ],
  };
  const { spec, m1, m2 } = build({ alphabet: ["a", "b"], automata: [a, b] });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "distinguished");
  if (res.status !== "distinguished") return;
  assert.equal(res.kind, "acceptance");
  assert.deepEqual(res.word, ["a", "b"]);
});

test("missing edges fall into the rejecting sink", () => {
  const a = {
    name: "A",
    states: ["q0", "q1"],
    initial: "q0",
    accepting: ["q1"],
    transitions: [{ from: "q0", on: "a", to: "q1", output: null }],
  };
  const b = { name: "B", states: ["p0"], initial: "p0", accepting: [], transitions: [] };
  const { spec, m1, m2 } = build({ alphabet: ["a"], automata: [a, b] });

  // B has no edge on "a": sinks immediately.
  const stepB = m2.step("p0", [], 0);
  assert.equal(stepB.state, SINK_STATE);
  assert.equal(stepB.output, null);
  assert.equal(m2.isAccepting(stepB.state), false);
  // The sink loops on itself.
  assert.equal(m2.step(SINK_STATE, [], 0).state, SINK_STATE);

  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "distinguished");
  if (res.status !== "distinguished") return;
  assert.deepEqual(res.word, ["a"]);
  assert.equal(res.kind, "acceptance");
});

test("empty word distinguishes when initial acceptance differs", () => {
  const a = { name: "A", states: ["q0"], initial: "q0", accepting: ["q0"], transitions: [] };
  const b = { name: "B", states: ["p0"], initial: "p0", accepting: [], transitions: [] };
  const { spec, m1, m2 } = build({ alphabet: ["a"], automata: [a, b] });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "distinguished");
  if (res.status !== "distinguished") return;
  assert.deepEqual(res.word, []);
});

test("register updates make outputs diverge: shortest word and 8-bit wrap", () => {
  // Both machines loop on "a" emitting the register value; A increments by 1,
  // B increments by 2. Outputs first diverge on the second symbol.
  const a = {
    name: "A",
    states: ["q0"],
    initial: "q0",
    accepting: ["q0"],
    transitions: [{ from: "q0", on: "a", to: "q0", output: "x", update: { x: "x + 1" } }],
  };
  const b = {
    name: "B",
    states: ["p0"],
    initial: "p0",
    accepting: ["p0"],
    transitions: [{ from: "p0", on: "a", to: "p0", output: "x", update: { x: "x + 2" } }],
  };
  const { spec, m1, m2 } = build({
    alphabet: ["a"],
    registers: ["x"],
    initialRegisters: { x: 0 },
    automata: [a, b],
  });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "distinguished");
  if (res.status !== "distinguished") return;
  assert.equal(res.kind, "output");
  assert.deepEqual(res.word, ["a", "a"]);
});

test("equivalence explores all reachable 8-bit register states", () => {
  // Single-state machines whose register cycles through all 256 values;
  // outputs always agree, so the checker must visit all 256 product configs.
  const mk = (name: string) => ({
    name,
    states: ["s0"],
    initial: "s0",
    accepting: ["s0"],
    transitions: [{ from: "s0", on: "a", to: "s0", output: 0, update: { x: "x + 1" } }],
  });
  const { spec, m1, m2 } = build({
    alphabet: ["a"],
    registers: ["x"],
    automata: [mk("A"), mk("B")],
  });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "equivalent");
  if (res.status !== "equivalent") return;
  assert.equal(res.certificate.reachableConfigurations, 256);
});

test("register updates are masked to 8 bits (x + 257 === x + 1)", () => {
  const a = {
    name: "A",
    states: ["q0"],
    initial: "q0",
    accepting: ["q0"],
    transitions: [{ from: "q0", on: "a", to: "q0", output: "x", update: { x: "x + 1" } }],
  };
  const b = {
    name: "B",
    states: ["p0"],
    initial: "p0",
    accepting: ["p0"],
    transitions: [{ from: "p0", on: "a", to: "p0", output: "x", update: { x: "x + 257" } }],
  };
  const { spec, m1, m2 } = build({ alphabet: ["a"], registers: ["x"], automata: [a, b] });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "equivalent");
  if (res.status !== "equivalent") return;
  assert.equal(res.certificate.reachableConfigurations, 256);
});

test("unobservable register divergence does not break equivalence", () => {
  // y evolves differently in the two machines but is never emitted; only x
  // is observable, and x evolves identically.
  const a = {
    name: "A",
    states: ["q0"],
    initial: "q0",
    accepting: ["q0"],
    transitions: [{ from: "q0", on: "a", to: "q0", output: "x", update: { x: "x + 1", y: "y + 1" } }],
  };
  const b = {
    name: "B",
    states: ["p0"],
    initial: "p0",
    accepting: ["p0"],
    transitions: [{ from: "p0", on: "a", to: "p0", output: "x", update: { x: "x + 1", y: "y + 2" } }],
  };
  const { spec, m1, m2 } = build({ alphabet: ["a"], registers: ["x", "y"], automata: [a, b] });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, spec.stateBudget);
  assert.equal(res.status, "equivalent");
});

test("state budget exhaustion yields unknown, never equivalence", () => {
  // Product space has 256 reachable configurations; a budget of 10 must
  // interrupt the search and must not claim equivalence.
  const mk = (name: string) => ({
    name,
    states: ["s0"],
    initial: "s0",
    accepting: ["s0"],
    transitions: [{ from: "s0", on: "a", to: "s0", output: 0, update: { x: "x + 1" } }],
  });
  const { spec, m1, m2 } = build({ alphabet: ["a"], registers: ["x"], automata: [mk("A"), mk("B")] });
  const res = checkEquivalence(m1, m2, spec.initialRegisters, 10);
  assert.equal(res.status, "unknown");
  if (res.status !== "unknown") return;
  assert.match(res.reason, /budget/);
  assert.match(res.reason, /not established/);
  assert.equal(res.explored, 10);
});

test("enumeration cross-check reports counterexamples for wrong pairs", () => {
  const a = {
    name: "A",
    states: ["q0", "q1"],
    initial: "q0",
    accepting: ["q1"],
    transitions: [{ from: "q0", on: "a", to: "q1" }],
  };
  const b = { name: "B", states: ["p0"], initial: "p0", accepting: [], transitions: [] };
  const { spec, m1, m2 } = build({ alphabet: ["a", "b"], automata: [a, b] });
  const report = verifyByEnumeration(m1, m2, spec.initialRegisters, 10000);
  assert.equal(report.ok, false);
  assert.deepEqual(report.counterexample, ["a"]);
});
