import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsStdin, runCli } from "../src/cli.js";

test("cli solves an instance from stdin", () => {
  const inst = {
    capacity: 10,
    items: [
      { id: 1, size: 6 },
      { id: 2, size: 4 },
      { id: 3, size: 4 },
      { id: 4, size: 2 },
    ],
    forbidden: [[1, 3]],
  };
  const res = runCli([], JSON.stringify(inst));
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.bins, 2);
  assert.notEqual(out.assignment["1"], out.assignment["3"]);
  const sums = [0, 0];
  for (const it of inst.items) {
    const idx = out.assignment[String(it.id)] - 1;
    sums[idx] = (sums[idx] ?? 0) + it.size;
  }
  assert.deepEqual(sums, out.loads);
});

test("cli reads an instance from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "binpack-"));
  const file = join(dir, "inst.json");
  writeFileSync(
    file,
    JSON.stringify({
      capacity: 5,
      items: [
        { id: 2, size: 5 },
        { id: 1, size: 5 },
      ],
    }),
  );
  const res = runCli([file], "");
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.bins, 2);
  assert.equal(out.assignment["1"], 1);
  assert.equal(out.assignment["2"], 2);
});

test("cli reports infeasible with exit code 1", () => {
  const inst = {
    capacity: 3,
    items: [
      { id: 1, size: 2, group: "g" },
      { id: 2, size: 2, group: "g" },
    ],
  };
  const res = runCli([], JSON.stringify(inst));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error, "infeasible");
});

test("cli reports invalid input with exit code 2", () => {
  const res = runCli([], JSON.stringify({ capacity: 3, items: [] }));
  assert.equal(res.code, 2);
  assert.equal(JSON.parse(res.stderr).error, "invalid_input");
});

test("cli rejects malformed JSON and unknown flags with exit code 2", () => {
  assert.equal(runCli([], "not json").code, 2);
  assert.equal(runCli(["--bogus"], "").code, 2);
});

test("cli --help prints usage", () => {
  const res = runCli(["--help"], "");
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes("Usage: binpack"));
});

test("needsStdin detects a file argument", () => {
  assert.equal(needsStdin([]), true);
  assert.equal(needsStdin(["--pretty"]), true);
  assert.equal(needsStdin(["inst.json"]), false);
  assert.equal(needsStdin(["--pretty", "inst.json"]), false);
});
