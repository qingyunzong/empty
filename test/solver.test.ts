import { test } from "node:test";
import assert from "node:assert/strict";
import {
  solve,
  InfeasibleError,
  InvalidInputError,
  MAX_ITEMS,
  type Instance,
  type Solution,
} from "../src/solver.js";
import { bruteForce } from "./brute.js";

function checkFeasible(inst: Instance, sol: Solution): void {
  const binOf = new Map<number, number>();
  for (const it of inst.items) {
    const b = sol.assignment.get(it.id);
    assert.ok(b !== undefined, "item " + it.id + " is assigned");
    assert.ok(b >= 1 && b <= sol.bins, "item " + it.id + " has a valid bin");
    binOf.set(it.id, b);
  }
  // Capacity.
  const sums = new Array<number>(sol.bins).fill(0);
  for (const it of inst.items) sums[binOf.get(it.id)! - 1]! += it.size;
  for (const s of sums) assert.ok(s <= inst.capacity, "bin load " + s + " <= " + inst.capacity);
  assert.deepEqual(sums, sol.loads, "reported loads match the assignment");
  // Same group -> same bin.
  const groupBin = new Map<string, number>();
  for (const it of inst.items) {
    if (it.group === undefined) continue;
    const key = String(it.group);
    const prev = groupBin.get(key);
    if (prev === undefined) groupBin.set(key, binOf.get(it.id)!);
    else assert.equal(binOf.get(it.id), prev, "group " + key + " shares a bin");
  }
  // Forbidden pairs.
  for (const [a, b] of inst.forbidden ?? []) {
    assert.notEqual(binOf.get(a), binOf.get(b), "forbidden pair " + a + "," + b + " separated");
  }
  // Bin numbers normalized by smallest item id.
  const minIdInBin = new Array<number>(sol.bins).fill(Infinity);
  for (const it of inst.items) {
    const b = binOf.get(it.id)!;
    if (it.id < minIdInBin[b - 1]!) minIdInBin[b - 1] = it.id;
  }
  for (let b = 1; b < sol.bins; b++) {
    assert.ok(minIdInBin[b - 1]! < minIdInBin[b]!, "bin numbers ordered by smallest item id");
  }
}

test("single item", () => {
  const sol = solve({ capacity: 5, items: [{ id: 7, size: 3 }] });
  assert.equal(sol.bins, 1);
  assert.deepEqual(sol.loads, [3]);
  assert.equal(sol.assignment.get(7), 1);
});

test("minimizes bin count, not first-fit", () => {
  // First-fit decreasing would use 3 bins: 6+? ... optimal is 2.
  const sol = solve({
    capacity: 10,
    items: [
      { id: 1, size: 6 },
      { id: 2, size: 4 },
      { id: 3, size: 4 },
      { id: 4, size: 2 },
    ],
  });
  assert.equal(sol.bins, 2);
});

test("tie-break: lexicographically smallest canonical load sequence", () => {
  // 2-bin optima include (6, 10), (8, 8) and (10, 6); (6, 10) is lexicographically
  // smallest, so item 1 sits alone in bin 1.
  const sol = solve({
    capacity: 10,
    items: [
      { id: 1, size: 6 },
      { id: 2, size: 4 },
      { id: 3, size: 4 },
      { id: 4, size: 2 },
    ],
  });
  assert.deepEqual(sol.loads, [6, 10]);
  assert.equal(sol.assignment.get(1), 1);
  assert.equal(sol.assignment.get(2), 2);
  assert.equal(sol.assignment.get(3), 2);
  assert.equal(sol.assignment.get(4), 2);
});

test("tie-break: later positions decide when the first load is equal", () => {
  // Bin 1 must hold item 1 (load 6). The rest admits load sequences (8, 10)
  // and (10, 8) in canonical order; expect (8, 10).
  const sol = solve({
    capacity: 10,
    items: [
      { id: 1, size: 6 },
      { id: 2, size: 2 },
      { id: 3, size: 5 },
      { id: 4, size: 3 },
      { id: 5, size: 5 },
      { id: 6, size: 3 },
    ],
  });
  assert.equal(sol.bins, 3);
  assert.deepEqual(sol.loads, [6, 8, 10]);
  assert.equal(sol.assignment.get(1), 1);
  assert.equal(sol.assignment.get(2), 2);
  assert.equal(sol.assignment.get(4), 2);
  assert.equal(sol.assignment.get(6), 2);
  assert.equal(sol.assignment.get(3), 3);
  assert.equal(sol.assignment.get(5), 3);
});

test("bin numbers normalized by smallest item id", () => {
  const sol = solve({
    capacity: 5,
    items: [
      { id: 10, size: 5 },
      { id: 3, size: 5 },
    ],
  });
  assert.equal(sol.bins, 2);
  assert.equal(sol.assignment.get(3), 1, "smallest item id is in bin 1");
  assert.equal(sol.assignment.get(10), 2);
});

test("same group forced into one bin", () => {
  const inst: Instance = {
    capacity: 8,
    items: [
      { id: 1, size: 3, group: "g" },
      { id: 2, size: 4, group: "g" },
      { id: 3, size: 5 },
    ],
    forbidden: [],
  };
  const sol = solve(inst);
  checkFeasible(inst, sol);
  assert.equal(sol.assignment.get(1), sol.assignment.get(2));
  assert.equal(sol.bins, 2);
});

test("forbidden pair kept apart", () => {
  const inst: Instance = {
    capacity: 10,
    items: [
      { id: 1, size: 4 },
      { id: 2, size: 4 },
    ],
    forbidden: [[1, 2]],
  };
  const sol = solve(inst);
  checkFeasible(inst, sol);
  assert.equal(sol.bins, 2);
});

test("infeasible: forbidden pair inside one group", () => {
  assert.throws(
    () =>
      solve({
        capacity: 10,
        items: [
          { id: 1, size: 2, group: "g" },
          { id: 2, size: 2, group: "g" },
        ],
        forbidden: [[1, 2]],
      }),
    InfeasibleError,
  );
});

test("infeasible: group larger than capacity", () => {
  assert.throws(
    () =>
      solve({
        capacity: 5,
        items: [
          { id: 1, size: 3, group: "g" },
          { id: 2, size: 3, group: "g" },
        ],
      }),
    InfeasibleError,
  );
});

test("invalid input rejected", () => {
  assert.throws(() => solve({ capacity: 0, items: [{ id: 1, size: 1 }] }), InvalidInputError);
  assert.throws(() => solve({ capacity: 3.5, items: [{ id: 1, size: 1 }] }), InvalidInputError);
  assert.throws(() => solve({ capacity: 5, items: [] }), InvalidInputError);
  assert.throws(
    () =>
      solve({
        capacity: 5,
        items: [
          { id: 1, size: 1 },
          { id: 1, size: 1 },
        ],
      }),
    InvalidInputError,
  );
  assert.throws(() => solve({ capacity: 5, items: [{ id: 1, size: 0 }] }), InvalidInputError);
  assert.throws(
    () => solve({ capacity: 5, items: [{ id: 1, size: 1 }], forbidden: [[1, 9]] }),
    InvalidInputError,
  );
  const tooMany = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ id: i + 1, size: 1 }));
  assert.throws(() => solve({ capacity: 100, items: tooMany }), InvalidInputError);
});

test("20 items accepted", () => {
  const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({ id: i + 1, size: (i % 5) + 1 }));
  const inst: Instance = { capacity: 12, items, forbidden: [[1, 2]], };
  const sol = solve(inst);
  checkFeasible(inst, sol);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand: () => number): Instance {
  const n = 2 + Math.floor(rand() * 8); // 2..9 items
  const capacity = 4 + Math.floor(rand() * 10); // 4..13
  const items = Array.from({ length: n }, (_, i) => {
    const it: { id: number; size: number; group?: string } = {
      id: i + 1,
      size: 1 + Math.floor(rand() * Math.min(6, capacity)),
    };
    if (rand() < 0.35) it.group = "g" + Math.floor(rand() * 3);
    return it;
  });
  const forbidden: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < 0.15) forbidden.push([i + 1, j + 1]);
    }
  }
  return { capacity, items, forbidden };
}

test("random small instances match brute-force partition enumeration", () => {
  const rand = mulberry32(20261005);
  let feasible = 0;
  let infeasible = 0;
  for (let t = 0; t < 400; t++) {
    const inst = randomInstance(rand);
    const expected = bruteForce(inst);
    if (expected === null) {
      infeasible++;
      assert.throws(() => solve(inst), InfeasibleError, "instance " + t + " infeasible");
    } else {
      feasible++;
      const sol = solve(inst);
      checkFeasible(inst, sol);
      assert.equal(sol.bins, expected.bins, "instance " + t + " bin count");
      assert.deepEqual(sol.loads, expected.loads, "instance " + t + " canonical loads");
    }
  }
  assert.ok(feasible > 200, "enough feasible cases covered: " + feasible);
  assert.ok(infeasible > 0, "some infeasible cases covered: " + infeasible);
});
