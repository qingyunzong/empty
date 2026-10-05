import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstance } from "../src/parse.js";

test("rejects more than 24 people", () => {
  const people = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, cost: 1 }));
  assert.throws(() => parseInstance({ people }), /at most 24 people/);
});

test("rejects more than 12 distinct skills", () => {
  const skills = Array.from({ length: 13 }, (_, i) => `s${i}`);
  assert.throws(() => parseInstance({ people: [{ id: "a", skills, cost: 1 }] }), /at most 12/);
});

test("rejects duplicate ids", () => {
  assert.throws(
    () => parseInstance({ people: [{ id: "a", cost: 1 }, { id: "a", cost: 2 }] }),
    /duplicate person id/
  );
});

test("rejects negative or non-finite costs", () => {
  assert.throws(() => parseInstance({ people: [{ id: "a", cost: -1 }] }), /cost/);
  assert.throws(() => parseInstance({ people: [{ id: "a", cost: Number.NaN }] }), /cost/);
});

test("rejects unknown ids in forbidden pairs", () => {
  assert.throws(
    () => parseInstance({ people: [{ id: "a", cost: 1 }], forbiddenPairs: [["a", "b"]] }),
    /unknown id: b/
  );
});

test("rejects self-pairs and duplicate pairs", () => {
  const people = [{ id: "a", cost: 1 }, { id: "b", cost: 1 }];
  assert.throws(() => parseInstance({ people, forbiddenPairs: [["a", "a"]] }), /identical endpoints/);
  assert.throws(
    () => parseInstance({ people, forbiddenPairs: [["a", "b"], ["b", "a"]] }),
    /duplicate forbidden pair/
  );
});

test("rejects invalid minSkills entries", () => {
  const people = [{ id: "a", skills: ["s1"], cost: 1 }];
  assert.throws(() => parseInstance({ people, minSkills: { s1: 1.5 } }), /integer >= 0/);
  assert.throws(() => parseInstance({ people, minSkills: { s1: -2 } }), /integer >= 0/);
});

test("accepts a minimal instance", () => {
  const instance = parseInstance({ people: [] });
  assert.equal(instance.people.length, 0);
  assert.equal(instance.skills.length, 0);
});
