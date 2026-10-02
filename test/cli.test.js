import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, writeJson } from "../helpers/testing.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "cli.js");

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runCli(args) {
  const dir = makeTmpDir();
  const outPath = join(dir, "stdout.txt");
  const errPath = join(dir, "stderr.txt");
  const codePath = join(dir, "code.txt");
  const command =
    [process.execPath, cli, ...args].map(shQuote).join(" ") +
    ` >${shQuote(outPath)} 2>${shQuote(errPath)}; printf %s $? > ${shQuote(codePath)}`;
  spawnSync("sh", ["-c", command]);
  return {
    status: Number(readFileSync(codePath, "utf8")),
    stdout: readFileSync(outPath, "utf8"),
    stderr: readFileSync(errPath, "utf8"),
  };
}

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

function renamedMachine() {
  return {
    states: ["x0", "x1", "x2", "x3"],
    alphabet: ["a", "b"],
    start: "x0",
    risk: { x0: "low", x1: "low", x2: "low", x3: "low" },
    transitions: {
      x0: { a: "x1", b: "x0" },
      x1: { a: "x2", b: "x1" },
      x2: { a: "x3", b: "x2" },
      x3: { a: "x3", b: "x3" },
    },
  };
}

test("renamed equivalent machine: equal=true, exit 0", () => {
  const dir = makeTmpDir();
  const oldPath = writeJson(dir, "old.json", chainMachine("low"));
  const newPath = writeJson(dir, "new.json", renamedMachine());
  const res = runCli([oldPath, newPath, "3"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.equal, true);
  assert.equal(out.witness, null);
  assert.deepEqual(out.tasks, []);
  assert.equal(out.cost, 0);
  assert.match(out.planHash, /^[0-9a-f]{64}$/);
});

test("difference at step 3: witness length 3", () => {
  const dir = makeTmpDir();
  const oldPath = writeJson(dir, "old.json", chainMachine("low"));
  const newPath = writeJson(dir, "new.json", chainMachine("high"));
  const res = runCli([oldPath, newPath, "10"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.equal, false);
  assert.equal(out.witness.length, 3);
  assert.deepEqual(out.witness, ["a", "a", "a"]);
});

test("deterministic output across repeated runs with tied optima", () => {
  const dir = makeTmpDir();
  const oldPath = writeJson(dir, "old.json", {
    states: ["s0", "o1", "o2"],
    alphabet: ["a", "b"],
    start: "s0",
    risk: { s0: "low", o1: "high", o2: "high" },
    transitions: {
      s0: { a: "o1", b: "o2" },
      o1: { a: "o1", b: "o1" },
      o2: { a: "o2", b: "o2" },
    },
  });
  const newPath = writeJson(dir, "new.json", {
    states: ["t0", "n1", "n2"],
    alphabet: ["a", "b"],
    start: "t0",
    risk: { t0: "low", n1: "low", n2: "low" },
    transitions: {
      t0: { a: "n1", b: "n2" },
      n1: { a: "n1", b: "n1" },
      n2: { a: "n2", b: "n2" },
    },
  });
  const first = runCli([oldPath, newPath, "5"]);
  const second = runCli([oldPath, newPath, "5"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  const out = JSON.parse(first.stdout);
  assert.deepEqual(out.tasks, [
    { id: "new:n1", cost: 1 },
    { id: "new:n2", cost: 1 },
  ]);
});

test("exit 7: negative budget, missing state, non-integer cost", () => {
  const dir = makeTmpDir();
  const oldPath = writeJson(dir, "old.json", chainMachine("low"));
  const newPath = writeJson(dir, "new.json", chainMachine("high"));

  assert.equal(runCli([oldPath, newPath, "-1"]).status, 7);
  assert.equal(runCli([oldPath, newPath, "2.5"]).status, 7);

  const missing = chainMachine("high");
  missing.transitions.s0.a = "ghost";
  const missingPath = writeJson(dir, "missing.json", missing);
  assert.equal(runCli([oldPath, missingPath, "5"]).status, 7);

  const badCost = chainMachine("high");
  badCost.costs = { s3: 1.5 };
  const badCostPath = writeJson(dir, "badcost.json", badCost);
  assert.equal(runCli([oldPath, badCostPath, "5"]).status, 7);
});

test("insufficient budget prints INFEASIBLE and exits 8", () => {
  const dir = makeTmpDir();
  const oldCostly = chainMachine("low");
  oldCostly.costs = { s3: 4 };
  const oldPath = writeJson(dir, "old.json", oldCostly);
  const costly = chainMachine("high");
  costly.costs = { s3: 4 };
  const newPath = writeJson(dir, "new.json", costly);
  const res = runCli([oldPath, newPath, "3"]);
  assert.equal(res.status, 8);
  assert.match(res.stdout, /INFEASIBLE/);
});

test("--save writes a plan that load can read; corrupt plan exits 7", () => {
  const dir = makeTmpDir();
  const oldPath = writeJson(dir, "old.json", chainMachine("low"));
  const newPath = writeJson(dir, "new.json", chainMachine("high"));
  const planPath = join(dir, "plan.json");

  const res = runCli([oldPath, newPath, "10", "--save", planPath]);
  assert.equal(res.status, 0, res.stderr);

  const loadRes = runCli(["load", planPath]);
  assert.equal(loadRes.status, 0, loadRes.stderr);
  const plan = JSON.parse(loadRes.stdout);
  assert.equal(plan.equal, false);
  assert.equal(plan.version, 1);

  const text = readFileSync(planPath, "utf8");
  writeFileSync(planPath, text.slice(0, text.length / 2));
  const corrupt = runCli(["load", planPath]);
  assert.equal(corrupt.status, 7);
  assert.match(corrupt.stderr, /error:/);
});
