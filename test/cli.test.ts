import { test } from "node:test";
import { equal, match } from "node:assert/strict";
import { run } from "../src/app.js";

test("CLI: equivalent pair exits 0 and prints certificate plus verification", () => {
  const r = run(["examples/equiv-a.json", "examples/equiv-b.json"]);
  equal(r.code, 0);
  match(r.stdout, /Result: EQUIVALENT/);
  match(r.stdout, /Certificate of reachable product states:/);
  match(r.stdout, /Verification: enumerated \d+ words/);
});

test("CLI: differing pair exits 1 with shortest word and dual traces", () => {
  const r = run(["examples/diff-a.json", "examples/diff-b.json"]);
  equal(r.code, 1);
  match(r.stdout, /Result: NOT EQUIVALENT/);
  match(r.stdout, /Shortest distinguishing word: a b \(length 2\)/);
  match(r.stdout, /Trace client:/);
  match(r.stdout, /Trace server:/);
});

test("CLI: budget exhaustion exits 2 and never claims equivalence", () => {
  const r = run(["examples/equiv-a.json", "examples/equiv-b.json", "--budget", "1"]);
  equal(r.code, 2);
  match(r.stdout, /Result: UNKNOWN/);
  match(r.stdout, /Cannot claim equivalence/);
});

test("CLI: usage error exits 3", () => {
  const r = run(["examples/equiv-a.json"]);
  equal(r.code, 3);
  match(r.stderr, /expected exactly 2 automaton files/);
});

test("CLI: mismatched alphabets are rejected", () => {
  const r = run(["examples/equiv-a.json", "examples/equiv-a.json", "--budget", "x" as string]);
  equal(r.code, 3);
  match(r.stderr, /invalid value for --budget/);
});
