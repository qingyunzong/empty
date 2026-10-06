import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { run } from "../src/app.js";

const SAMPLE = JSON.stringify({
  liquids: [
    { name: "water", concentration: "0", cost: 1 },
    { name: "syrup", concentration: "3/4", cost: 4 },
  ],
  target: ["1/4", "1/2"],
});

function runCli(args: string[], stdinText = "") {
  return run(args, () => stdinText, (path) => {
    throw new Error(`unexpected file read: ${path}`);
  });
}

test("optimal solution via stdin with exact concentration", () => {
  const r = runCli([], SAMPLE);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "optimal");
  assert.equal(out.cost, 5);
  assert.equal(out.total, 2);
  assert.equal(out.concentration, "3/8");
  assert.deepEqual(out.vector, [1, 1]);
  assert.deepEqual(out.amounts, [
    { name: "water", amount: 1 },
    { name: "syrup", amount: 1 },
  ]);
});

test("reads input from a file and honors --max-total", () => {
  const file = `/tmp/blend-cli-test-${process.pid}.json`;
  writeFileSync(file, SAMPLE);
  const r = run(
    [file, "--max-total", "1"],
    () => {
      throw new Error("should not read stdin");
    },
    (path) => {
      assert.equal(path, file);
      return SAMPLE;
    },
  );
  assert.equal(r.code, 1, r.stderr); // no single unit hits [1/4, 1/2]
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "infeasible");
  assert.equal(out.maxTotal, 1);
});

test("infeasible instance exits 1 after completing the search", () => {
  const r = runCli(
    [],
    JSON.stringify({
      liquids: [
        { name: "a", concentration: "3/4", cost: 1 },
        { name: "b", concentration: "1", cost: 1 },
      ],
      target: { min: "0", max: "1/2" },
    }),
  );
  assert.equal(r.code, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "infeasible");
  assert.ok(out.nodesExplored > 0);
});

test("validation errors exit 2", () => {
  const tooMany = {
    liquids: Array.from({ length: 13 }, (_, i) => ({ name: `l${i}`, concentration: "1/2", cost: 1 })),
    target: ["0", "1"],
  };
  assert.equal(runCli([], JSON.stringify(tooMany)).code, 2);
  assert.equal(runCli([], "not json").code, 2);
  assert.equal(
    runCli([], JSON.stringify({ liquids: [{ concentration: "1/2", cost: 1 }], target: ["1", "0"] })).code,
    2,
  );
  assert.equal(
    runCli([], JSON.stringify({ liquids: [{ concentration: "1/2", cost: -3 }], target: ["0", "1"] })).code,
    2,
  );
  assert.equal(
    runCli([], JSON.stringify({ liquids: [{ concentration: "1/2" }], target: ["0", "1"] })).code,
    2,
  );
  assert.equal(runCli(["--max-total", "41"], SAMPLE).code, 2);
  assert.equal(runCli(["--bogus"], SAMPLE).code, 2);
});

test("--help prints usage", () => {
  const r = runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Usage:"));
});
