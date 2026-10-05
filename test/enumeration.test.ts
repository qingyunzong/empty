import { test } from "node:test";
import * as assert from "node:assert/strict";
import { solve } from "../src/mincostflow";
import { enumerateFlows } from "../src/enumerate";
import { mulberry32, randomNetwork } from "./helpers";

const CASES = 300;

test("solver matches brute-force enumeration on random small networks (exact)", () => {
  const rand = mulberry32(20261005);
  let feasibleCount = 0;
  for (let i = 0; i < CASES; i++) {
    const spec = randomNetwork(rand);
    const brute = enumerateFlows(spec);
    const result = solve(spec);
    const bruteCost = brute.costByAmount[spec.amount] ?? null;
    if (bruteCost === null) {
      assert.equal(result.status, "infeasible", `case ${i}: solver should report infeasible`);
    } else {
      assert.equal(result.status, "optimal", `case ${i}: solver should be optimal`);
      assert.equal(result.totalCost, bruteCost, `case ${i}: cost mismatch`);
      assert.ok(result.certificate.valid, `case ${i}: certificate must verify`);
      feasibleCount++;
    }
  }
  assert.ok(feasibleCount > CASES / 2, "expected most random cases to be feasible");
});

test("solver matches brute-force enumeration on random small networks (at-most)", () => {
  const rand = mulberry32(77031);
  for (let i = 0; i < CASES; i++) {
    const spec = { ...randomNetwork(rand), atMost: true };
    const brute = enumerateFlows(spec);
    const result = solve(spec);
    assert.ok(brute.bestAtMost !== null, `case ${i}: zero flow is always feasible`);
    assert.equal(result.status, "optimal", `case ${i}`);
    assert.equal(result.sent, brute.bestAtMost!.sent, `case ${i}: sent mismatch`);
    assert.equal(result.totalCost, brute.bestAtMost!.cost, `case ${i}: cost mismatch`);
    assert.ok(result.certificate.valid, `case ${i}: certificate must verify`);
  }
});
