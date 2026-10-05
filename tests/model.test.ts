import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CANDIDATES,
  buildEvidence,
  validateProblem,
  type Problem,
} from "../src/model.js";

test("validate: accepts a minimal well-formed problem", () => {
  const { problem, errors } = validateProblem({
    candidates: [{ id: "r1", cost: 1, effect: "allow", matches: ["s1"] }],
    samples: [{ id: "s1", expect: "allow" }],
  });
  assert.deepEqual(errors, []);
  assert.ok(problem);
  assert.equal(problem.candidates.length, 1);
});

test("validate: rejects more than MAX_CANDIDATES candidates", () => {
  const candidates = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({
    id: `r${i}`,
    cost: 1,
    effect: "deny",
    matches: [],
  }));
  const { problem, errors } = validateProblem({ candidates, samples: [] });
  assert.equal(problem, null);
  assert.ok(errors.some((e) => e.includes(`at most ${MAX_CANDIDATES}`)));
});

test("validate: rejects duplicate ids, bad refs, negative cost, bad effect", () => {
  const { problem, errors } = validateProblem({
    candidates: [
      { id: "r1", cost: -1, effect: "allow", matches: ["s1"] },
      { id: "r1", cost: 1, effect: "allow", matches: ["s1"] },
      { id: "r2", cost: 1, effect: "maybe", matches: ["s1"] },
      { id: "r3", cost: 1, effect: "deny", matches: ["ghost"] },
    ],
    samples: [{ id: "s1", expect: "allow" }],
  });
  assert.equal(problem, null);
  assert.ok(errors.some((e) => e.includes("cost")));
  assert.ok(errors.some((e) => e.includes("duplicate")));
  assert.ok(errors.some((e) => e.includes('"effect"')));
  assert.ok(errors.some((e) => e.includes("unknown sample")));
});

const semantics: Problem = {
  candidates: [
    { id: "a", cost: 1, effect: "allow", matches: ["s1"] },
    { id: "d", cost: 1, effect: "deny", matches: ["s1"] },
  ],
  samples: [{ id: "s1", expect: "deny" }],
};

test("evidence: deny rule overrides allow rule (deny priority)", () => {
  const [e] = buildEvidence(semantics, [0, 1]);
  assert.equal(e!.actual, "deny");
  assert.deepEqual(e!.decidedBy, ["d"]);
  assert.match(e!.reason, /deny priority/);
});

test("evidence: allow when only allow rules match", () => {
  const [e] = buildEvidence(semantics, [0]);
  assert.equal(e!.actual, "allow");
  assert.deepEqual(e!.decidedBy, ["a"]);
});

test("evidence: default deny when no selected rule matches", () => {
  const [e] = buildEvidence(semantics, []);
  assert.equal(e!.actual, "deny");
  assert.deepEqual(e!.decidedBy, []);
  assert.match(e!.reason, /default deny/);
});
