import test from "node:test";
import assert from "node:assert/strict";
import { parseDfa } from "../src/dfa.js";
import { compareDfas } from "../src/equivalence.js";
import { mulberry32, randomDfa, bruteForceEqual } from "../helpers/testing.js";

test("renamed but isomorphic machines are equal", () => {
  const oldRaw = {
    states: ["q0", "q1"],
    alphabet: ["a", "b"],
    start: "q0",
    risk: { q0: "low", q1: "high" },
    transitions: {
      q0: { a: "q1", b: "q0" },
      q1: { a: "q0", b: "q1" },
    },
  };
  const newRaw = {
    states: ["z", "y"],
    alphabet: ["a", "b"],
    start: "z",
    risk: { z: "low", y: "high" },
    transitions: {
      z: { a: "y", b: "z" },
      y: { a: "z", b: "y" },
    },
  };
  const result = compareDfas(parseDfa(oldRaw, "old"), parseDfa(newRaw, "new"));
  assert.equal(result.equal, true);
  assert.equal(result.witness, null);
  assert.deepEqual(result.divergentPairs, []);
});

function chainMachine(riskAtS3) {
  return {
    states: ["s0", "s1", "s2", "s3"],
    alphabet: ["a", "b"],
    start: "s0",
    risk: { s0: "low", s1: "low", s2: "low", s3: riskAtS3 },
    transitions: {
      s0: { a: "s1", b: "s0" },
      s1: { a: "s2", b: "s1" },
      s2: { a: "s3", b: "s2" },
      s3: { a: "s3", b: "s3" },
    },
  };
}

test("difference first reachable at step 3 yields witness of length 3", () => {
  const oldDfa = parseDfa(chainMachine("low"), "old");
  const newDfa = parseDfa(chainMachine("high"), "new");
  const result = compareDfas(oldDfa, newDfa);
  assert.equal(result.equal, false);
  assert.equal(result.witness.length, 3);
  assert.deepEqual(result.witness, ["a", "a", "a"]);
});

test("bounded check respects m", () => {
  const oldDfa = parseDfa(chainMachine("low"), "old");
  const newDfa = parseDfa(chainMachine("high"), "new");
  assert.equal(compareDfas(oldDfa, newDfa, 2).equal, true);
  assert.equal(compareDfas(oldDfa, newDfa, 3).equal, false);
});

test("m<=6 results match brute-force enumeration of all sequences", () => {
  const risks = ["low", "mid", "high"];
  for (const seed of [1, 7, 42, 99, 1234]) {
    const rand = mulberry32(seed);
    const oldRaw = randomDfa(rand, { stateCount: 4, alphabet: ["a", "b"], risks });
    const newRaw = randomDfa(rand, { stateCount: 4, alphabet: ["a", "b"], risks });
    const oldDfa = parseDfa(oldRaw, "old");
    const newDfa = parseDfa(newRaw, "new");
    for (let m = 0; m <= 6; m += 1) {
      const expected = bruteForceEqual(oldDfa, newDfa, m);
      const actual = compareDfas(oldDfa, newDfa, m);
      assert.equal(actual.equal, expected.equal, `seed=${seed} m=${m} equal mismatch`);
      if (!expected.equal) {
        assert.equal(actual.witness.length, expected.witnessLength, `seed=${seed} m=${m} witness length`);
      }
    }
  }
});
