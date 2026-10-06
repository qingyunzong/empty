import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.js";
import { solve, type LiquidInput } from "../src/solver.js";

function liquid(name: string, concentration: string, cost: number): LiquidInput {
  return { name, concentration: Rational.parse(concentration), cost: BigInt(cost) };
}

test("minimizes cost with exact concentration output", () => {
  const res = solve(
    [liquid("water", "0", 1), liquid("syrup", "3/4", 4)],
    Rational.parse("1/4"),
    Rational.parse("1/2"),
    40,
  );
  assert.equal(res.status, "optimal");
  const sol = res.solution!;
  assert.equal(sol.cost, 5n); // one unit of each beats 2 water + 1 syrup (cost 6)
  assert.deepEqual(sol.amounts, [1, 1]);
  assert.equal(sol.total, 2);
  assert.equal(sol.concentration.toString(), "3/8");
});

test("tie-breaks by lexicographically smallest vector", () => {
  const res = solve(
    [liquid("a", "1/2", 2), liquid("b", "1/2", 2)],
    Rational.parse("1/2"),
    Rational.parse("1/2"),
    5,
  );
  assert.equal(res.status, "optimal");
  assert.equal(res.solution!.cost, 2n);
  assert.deepEqual(res.solution!.amounts, [0, 1]); // (0,1) < (1,0) lexicographically
});

test("zero-cost liquids still pick the lexicographically smallest feasible vector", () => {
  const res = solve(
    [liquid("zero", "0", 0), liquid("one", "1", 0)],
    Rational.parse("1/2"),
    Rational.parse("1/2"),
    10,
  );
  assert.equal(res.status, "optimal");
  assert.equal(res.solution!.cost, 0n);
  assert.deepEqual(res.solution!.amounts, [1, 1]);
  assert.equal(res.solution!.concentration.toString(), "1/2");
});

test("respects maxTotal", () => {
  const liquids = [liquid("zero", "0", 1), liquid("one", "1", 1)];
  const lo = Rational.parse("1/2");
  const hi = Rational.parse("1/2");
  assert.equal(solve(liquids, lo, hi, 1).status, "infeasible");
  const res = solve(liquids, lo, hi, 2);
  assert.equal(res.status, "optimal");
  assert.deepEqual(res.solution!.amounts, [1, 1]);
});

test("infeasible when every concentration is above the target", () => {
  const res = solve(
    [liquid("a", "3/4", 1), liquid("b", "1", 1)],
    Rational.parse("0"),
    Rational.parse("1/2"),
    40,
  );
  assert.equal(res.status, "infeasible");
  assert.equal(res.solution, null);
  assert.ok(res.nodesExplored > 0);
});

test("infeasible Farey-gap target completes the search", () => {
  // 7/17 and 12/29 are neighbours in the Farey sequence of order 40
  // (12*17 - 7*29 = 1 and 17 + 29 > 40), so no k/m with m <= 40 lies
  // strictly between them; mixes of 0 and 1 can never hit this interval.
  const res = solve(
    [liquid("zero", "0", 1), liquid("one", "1", 1)],
    Rational.parse("7017/17000"), // 7/17 + 1/1000
    Rational.parse("11971/29000"), // 12/29 - 1/1000
    40,
  );
  assert.equal(res.status, "infeasible");
  assert.ok(res.nodesExplored > 0);
});

test("twelve liquids solve quickly", () => {
  const liquids: LiquidInput[] = [];
  for (let i = 0; i < 12; i++) {
    liquids.push(liquid(`l${i}`, `${i}/11`, (i * 7) % 5));
  }
  const res = solve(liquids, Rational.parse("1/3"), Rational.parse("2/3"), 40);
  assert.equal(res.status, "optimal");
  const c = res.solution!.concentration;
  assert.ok(c.ge(Rational.parse("1/3")) && c.le(Rational.parse("2/3")));
});

test("twelve liquids with an unreachable narrow target complete the search", () => {
  const liquids: LiquidInput[] = [];
  for (let i = 0; i < 12; i++) {
    liquids.push(liquid(`l${i}`, `${i}/11`, 1));
  }
  // Any positive mix of {0, 1/11, ...} is at least 1/22 with <= 40 units... but
  // 1/22 > 1/1000, and 0 is below the interval, so nothing is feasible.
  const res = solve(liquids, Rational.parse("1/1000"), Rational.parse("1001/1000000"), 40);
  assert.equal(res.status, "infeasible");
});

test("rejects invalid parameters", () => {
  const liquids = [liquid("a", "1/2", 1)];
  assert.throws(() => solve([], Rational.parse("0"), Rational.parse("1"), 40));
  assert.throws(() => solve(liquids, Rational.parse("1"), Rational.parse("0"), 40));
  assert.throws(() => solve(liquids, Rational.parse("0"), Rational.parse("1"), 0));
  assert.throws(() =>
    solve([{ name: "x", concentration: Rational.parse("1/2"), cost: -1n }], Rational.parse("0"), Rational.parse("1"), 40),
  );
});
