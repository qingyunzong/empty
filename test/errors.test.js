"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { makeWorkspace, runCli, basePolicy } = require("./helpers");

function runWith(files) {
  const dir = makeWorkspace(files);
  return runCli([
    "run",
    "--defects", path.join(dir, "defects.jsonl"),
    "--policy", path.join(dir, "policy.json"),
    "--stock", path.join(dir, "stock.json"),
    "--outdir", dir,
  ]);
}

test("negative stock exits with code 19", () => {
  const result = runWith({
    "policy.json": JSON.stringify(basePolicy()),
    "stock.json": JSON.stringify({ BOX: -1 }),
    "defects.jsonl": JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 10 }),
  });
  assert.equal(result.status, 19, result.stderr);
  assert.match(result.stderr, /negative stock/);
});

test("unknown budget currency exits with code 20", () => {
  const result = runWith({
    "policy.json": JSON.stringify(basePolicy({ currency: "XXX" })),
    "stock.json": JSON.stringify({ BOX: 1 }),
    "defects.jsonl": JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 10 }),
  });
  assert.equal(result.status, 20, result.stderr);
  assert.match(result.stderr, /unknown budget currency/);
});

test("unknown currency in budgetCorrection event exits with code 20", () => {
  const result = runWith({
    "policy.json": JSON.stringify(basePolicy()),
    "stock.json": JSON.stringify({ BOX: 1 }),
    "defects.jsonl": [
      JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 10 }),
      JSON.stringify({ type: "budgetCorrection", amount: 5, currency: "BTC" }),
    ].join("\n"),
  });
  assert.equal(result.status, 20, result.stderr);
});

test("duplicate defect id exits with code 21", () => {
  const result = runWith({
    "policy.json": JSON.stringify(basePolicy()),
    "stock.json": JSON.stringify({ BOX: 1 }),
    "defects.jsonl": [
      JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 10 }),
      JSON.stringify({ id: "D1", product: "BOX", customer: "C", amount: 20 }),
    ].join("\n"),
  });
  assert.equal(result.status, 21, result.stderr);
  assert.match(result.stderr, /duplicate defect id/);
});
