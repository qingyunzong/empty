import { test } from "node:test";
import {
  deepEqual,
  equal,
  match,
  ok,
  throws,
} from "node:assert/strict";
import { Automaton, ParseError, parseAutomaton } from "../src/model.js";
import { checkEquivalence } from "../src/equivalence.js";

function make(raw: unknown, name = "M"): Automaton {
  return parseAutomaton(raw, name);
}

/** Single-state machine: loops on every symbol with output 0, acceptance configurable. */
function loopMachine(name: string, accepting: boolean): Automaton {
  return make({
    name,
    alphabet: ["a", "b"],
    initialState: "q0",
    initialRegisters: { r: 0 },
    states: {
      q0: {
        accepting,
        transitions: {
          a: { next: "q0", output: 0 },
          b: { next: "q0", output: 0 },
        },
      },
    },
  });
}

test("identical machines are equivalent, certificate covers the initial configuration", () => {
  const result = checkEquivalence(loopMachine("A", true), loopMachine("B", true));
  equal(result.kind, "equivalent");
  if (result.kind !== "equivalent") return;
  equal(result.explored, 1);
  equal(result.certificate.length, 1);
  match(result.certificate[0]!, /q0.*x.*q0/);
  ok(result.verification.wordsChecked > 0);
  ok(result.verification.complete);
});

test("empty word distinguishes when initial acceptance differs", () => {
  const result = checkEquivalence(loopMachine("A", true), loopMachine("B", false));
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  deepEqual(result.word, []);
  equal(result.reason, "acceptance");
  equal(result.traceA.accepting, true);
  equal(result.traceB.accepting, false);
});

test("lexicographic tie-break: smallest shortest word is returned", () => {
  // A accepts exactly the word "a", B accepts exactly the word "b".
  // Both "a" and "b" distinguish at length 1; "a" must win.
  const a = make({
    name: "A",
    alphabet: ["a", "b"],
    initialState: "q0",
    states: {
      q0: { accepting: false, transitions: { a: { next: "qa", output: 0 } } },
      qa: { accepting: true, transitions: {} },
    },
  });
  const b = make({
    name: "B",
    alphabet: ["a", "b"],
    initialState: "p0",
    states: {
      p0: { accepting: false, transitions: { b: { next: "pb", output: 0 } } },
      pb: { accepting: true, transitions: {} },
    },
  });
  const result = checkEquivalence(a, b);
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  deepEqual(result.word, ["a"]);
});

test("shortest word wins over longer distinguishing words", () => {
  const build = (name: string, finalAccepting: boolean): Automaton =>
    make({
      name,
      alphabet: ["a"],
      initialState: "s0",
      states: {
        s0: { accepting: false, transitions: { a: { next: "s1", output: 0 } } },
        s1: { accepting: false, transitions: { a: { next: "s2", output: 0 } } },
        s2: { accepting: finalAccepting, transitions: {} },
      },
    });
  const result = checkEquivalence(build("A", true), build("B", false));
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  deepEqual(result.word, ["a", "a"]);
});

test("differing integer outputs are detected even when acceptance agrees", () => {
  const a = loopMachine("A", false);
  const b = make({
    name: "B",
    alphabet: ["a", "b"],
    initialState: "q0",
    states: {
      q0: {
        accepting: false,
        transitions: {
          a: { next: "q0", output: 7 },
          b: { next: "q0", output: 0 },
        },
      },
    },
  });
  const result = checkEquivalence(a, b);
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  equal(result.reason, "output");
  deepEqual(result.word, ["a"]);
});

test("missing edge (sink, no output) differs from a present edge with output", () => {
  const a = make({
    name: "A",
    alphabet: ["a"],
    initialState: "q0",
    states: { q0: { accepting: false, transitions: { a: { next: "q0", output: 5 } } } },
  });
  const b = make({
    name: "B",
    alphabet: ["a"],
    initialState: "p0",
    states: { p0: { accepting: false, transitions: {} } },
  });
  const result = checkEquivalence(a, b);
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  equal(result.reason, "output");
  deepEqual(result.word, ["a"]);
});

test("missing edge leads to a rejecting sink (no output, non-accepting)", () => {
  // B has no edge on "a": it falls into the sink, emits nothing, and can
  // never accept again. The output difference (0 vs none) is observed first.
  const a = make({
    name: "A",
    alphabet: ["a"],
    initialState: "q0",
    states: {
      q0: { accepting: false, transitions: { a: { next: "q1", output: 0 } } },
      q1: { accepting: true, transitions: {} },
    },
  });
  const b = make({
    name: "B",
    alphabet: ["a"],
    initialState: "p0",
    states: { p0: { accepting: false, transitions: {} } },
  });
  const result = checkEquivalence(a, b);
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  equal(result.reason, "output");
  deepEqual(result.word, ["a"]);
  equal(result.traceB.finalConfig.state, "<sink>");
  equal(result.traceB.accepting, false);
});

test("acceptance differs when both machines take real edges along the whole word", () => {
  const build = (name: string, finalAccepting: boolean): Automaton =>
    make({
      name,
      alphabet: ["a"],
      initialState: "s0",
      states: {
        s0: { accepting: false, transitions: { a: { next: "s1", output: 0 } } },
        s1: { accepting: finalAccepting, transitions: { a: { next: "s1", output: 0 } } },
      },
    });
  const result = checkEquivalence(build("A", true), build("B", false));
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  equal(result.reason, "acceptance");
  deepEqual(result.word, ["a"]);
});

test("register updates are compared over reachable 8-bit register states", () => {
  const build = (name: string, increment: number): Automaton =>
    make({
      name,
      alphabet: ["a"],
      initialState: "s0",
      initialRegisters: { r: 0 },
      states: {
        s0: {
          accepting: false,
          transitions: { a: { next: "s0", output: 0, update: { r: { op: "add", value: increment } } } },
        },
      },
    });
  const result = checkEquivalence(build("A", 1), build("B", 2));
  equal(result.kind, "distinguished");
  if (result.kind !== "distinguished") return;
  equal(result.reason, "register");
  deepEqual(result.word, ["a"]);
});

test("8-bit wrap-around: +255 equals -1, so the machines are equivalent", () => {
  const build = (name: string, update: unknown): Automaton =>
    make({
      name,
      alphabet: ["a"],
      initialState: "s0",
      initialRegisters: { r: 0 },
      states: {
        s0: {
          accepting: false,
          transitions: { a: { next: "s0", output: 0, update: { r: update } } },
        },
      },
    });
  const a = build("A", { op: "add", value: 255 });
  const b = build("B", { op: "sub", value: 1 });
  const result = checkEquivalence(a, b);
  equal(result.kind, "equivalent");
  if (result.kind !== "equivalent") return;
  equal(result.explored, 256);
});

test("state budget exhaustion reports unknown, never equivalence", () => {
  // A 256-configuration register counter compared against itself.
  const counter = (name: string): Automaton =>
    make({
      name,
      alphabet: ["a"],
      initialState: "s0",
      initialRegisters: { r: 0 },
      states: {
        s0: {
          accepting: false,
          transitions: { a: { next: "s0", output: 0, update: { r: { op: "add", value: 1 } } } },
        },
      },
    });
  const result = checkEquivalence(counter("A"), counter("B"), { budget: 10 });
  equal(result.kind, "unknown");
  if (result.kind !== "unknown") return;
  equal(result.budget, 10);
  ok(result.explored >= 10);
});

test("validation: more than 30 states is rejected", () => {
  const states: Record<string, unknown> = {};
  for (let i = 0; i < 31; i++) states[`q${i}`] = { accepting: false, transitions: {} };
  throws(() => make({ alphabet: ["a"], initialState: "q0", states }), ParseError);
});

test("validation: duplicate alphabet symbols and bad register values are rejected", () => {
  throws(
    () =>
      make({
        alphabet: ["a", "a"],
        initialState: "q0",
        states: { q0: { accepting: false, transitions: {} } },
      }),
    ParseError
  );
  throws(
    () =>
      make({
        alphabet: ["a"],
        initialState: "q0",
        initialRegisters: { r: 256 },
        states: { q0: { accepting: false, transitions: {} } },
      }),
    ParseError
  );
});

test("validation: transition output must be an integer", () => {
  throws(
    () =>
      make({
        alphabet: ["a"],
        initialState: "q0",
        states: {
          q0: { accepting: false, transitions: { a: { next: "q0", output: "x" } } },
        },
      }),
    ParseError
  );
});
