import { test } from "node:test";
import * as assert from "node:assert/strict";
import { solve } from "../src/mincostflow";
import { verifyCertificate } from "../src/certificate";
import { InputError, MAX_AMOUNT } from "../src/graph";
import { NetworkSpec } from "../src/types";

test("piecewise fees: cheapest units are used first across parallel edges", () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: 3,
    edges: [
      { from: "S", to: "T", capacity: 2, segments: [{ upTo: 2, unitCost: 1 }] },
      {
        from: "S",
        to: "T",
        capacity: 2,
        segments: [
          { upTo: 1, unitCost: 0 },
          { upTo: 2, unitCost: 10 },
        ],
      },
    ],
  };
  const result = solve(spec);
  assert.equal(result.status, "optimal");
  assert.equal(result.sent, 3);
  assert.equal(result.totalCost, 2); // 0 + 1 + 1
  assert.deepEqual(
    result.flows.map((f) => f.flow),
    [2, 1]
  );
  assert.ok(result.certificate.valid);
});

test("negative fees: exact amount vs at-most amount", () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: 2,
    edges: [
      { from: "S", to: "A", capacity: 1, segments: [{ upTo: 1, unitCost: -2 }] },
      { from: "A", to: "T", capacity: 1, segments: [{ upTo: 1, unitCost: 1 }] },
      { from: "S", to: "T", capacity: 1, segments: [{ upTo: 1, unitCost: 2 }] },
    ],
  };
  const exact = solve(spec);
  assert.equal(exact.status, "optimal");
  assert.equal(exact.sent, 2);
  assert.equal(exact.totalCost, 1); // (-2 + 1) + 2
  assert.ok(exact.certificate.valid);

  const atMost = solve({ ...spec, atMost: true });
  assert.equal(atMost.status, "optimal");
  assert.equal(atMost.sent, 1); // sending only the negative-fee path is cheaper
  assert.equal(atMost.totalCost, -1);
  assert.deepEqual(atMost.costByAmount, [0, -1, 1]);
  assert.ok(atMost.certificate.valid);
});

test("infeasible amount reports max flow", () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: 5,
    edges: [{ from: "S", to: "T", capacity: 2, segments: [{ upTo: 2, unitCost: 3 }] }],
  };
  const result = solve(spec);
  assert.equal(result.status, "infeasible");
  assert.equal(result.maxFlow, 2);
});

test("zero amount is a trivial optimal flow", () => {
  const result = solve({
    source: "S",
    sink: "T",
    amount: 0,
    edges: [{ from: "S", to: "T", capacity: 1, segments: [{ upTo: 1, unitCost: 7 }] }],
  });
  assert.equal(result.status, "optimal");
  assert.equal(result.sent, 0);
  assert.equal(result.totalCost, 0);
  assert.ok(result.certificate.valid);
});

test("negative-cost cycles in the input are rejected", () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: 1,
    edges: [
      { from: "S", to: "T", capacity: 1, segments: [{ upTo: 1, unitCost: 1 }] },
      { from: "A", to: "B", capacity: 2, segments: [{ upTo: 2, unitCost: -3 }] },
      { from: "B", to: "A", capacity: 2, segments: [{ upTo: 2, unitCost: -3 }] },
    ],
  };
  assert.throws(() => solve(spec), InputError);
});

test("non-convex (decreasing) marginal fees are rejected", () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: 2,
    edges: [
      {
        from: "S",
        to: "T",
        capacity: 2,
        segments: [
          { upTo: 1, unitCost: 5 },
          { upTo: 2, unitCost: 1 },
        ],
      },
    ],
  };
  assert.throws(() => solve(spec), InputError);
});

test(`amount above ${MAX_AMOUNT} is rejected`, () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: MAX_AMOUNT + 1,
    edges: [
      { from: "S", to: "T", capacity: 30, segments: [{ upTo: 30, unitCost: 1 }] },
    ],
  };
  assert.throws(() => solve(spec), InputError);
});

test(`full ${MAX_AMOUNT}-unit transfer solves and certifies`, () => {
  const result = solve({
    source: "S",
    sink: "T",
    amount: MAX_AMOUNT,
    edges: [
      { from: "S", to: "T", capacity: 12, segments: [{ upTo: 12, unitCost: 2 }] },
      { from: "S", to: "T", capacity: 10, segments: [{ upTo: 10, unitCost: 3 }] },
    ],
  });
  assert.equal(result.status, "optimal");
  assert.equal(result.sent, MAX_AMOUNT);
  assert.equal(result.totalCost, 12 * 2 + 8 * 3);
  assert.ok(result.certificate.valid);
});

test("certificate catches tampered potentials", () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: 1,
    edges: [{ from: "S", to: "T", capacity: 1, segments: [{ upTo: 1, unitCost: 5 }] }],
  };
  const result = solve(spec);
  assert.ok(result.certificate.valid);

  const tampered = verifyCertificate(spec, result.flows, { S: 0, T: 0 }, 1, result.totalCost);
  assert.ok(!tampered.valid);
  const reducedCheck = tampered.checks.find((c) => c.name === "reduced-costs");
  assert.ok(reducedCheck !== undefined && !reducedCheck.ok);
});

test("certificate catches tampered flow conservation", () => {
  const spec: NetworkSpec = {
    source: "S",
    sink: "T",
    amount: 1,
    edges: [{ from: "S", to: "T", capacity: 2, segments: [{ upTo: 2, unitCost: 5 }] }],
  };
  const result = solve(spec);
  const badFlows = result.flows.map((f) => ({ ...f, flow: 2 }));
  const tampered = verifyCertificate(spec, badFlows, result.potentials, 1, result.totalCost);
  assert.ok(!tampered.valid);
});
