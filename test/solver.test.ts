import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Solver,
  allDifferent,
  table,
  enumerateBruteForce,
  MAX_VARS,
  type Constraint,
} from "../src/solver";

function isValidAssignment(
  assignment: number[],
  domainSizes: number[],
  constraints: Constraint[],
): boolean {
  for (let v = 0; v < assignment.length; v++) {
    if (assignment[v]! < 0 || assignment[v]! >= domainSizes[v]!) return false;
  }
  for (const c of constraints) {
    if (c.kind === "allDifferent") {
      const seen = new Set<number>();
      for (const v of c.scope) {
        if (seen.has(assignment[v]!)) return false;
        seen.add(assignment[v]!);
      }
    } else {
      const row = c.scope.map((v) => assignment[v]!);
      if (!c.tuples.some((t) => t.every((x, i) => x === row[i]))) return false;
    }
  }
  return true;
}

test("rejects more than 16 variables", () => {
  assert.throws(() => new Solver(new Array<number>(MAX_VARS + 1).fill(2)), /at most 16/);
  assert.ok(new Solver(new Array<number>(MAX_VARS).fill(2)));
});

test("allDifferent over 4 vars/domain 4 yields all 24 permutations", () => {
  const sizes = [4, 4, 4, 4];
  const constraints = [allDifferent(0, 1, 2, 3)];
  const solver = new Solver(sizes);
  for (const c of constraints) solver.addConstraint(c);
  const result = solver.solve("all");
  assert.equal(result.status, "sat");
  assert.equal(result.solutionCount, 24);
  assert.equal(result.frontier, 0);
  // Independent cross-check.
  assert.equal(enumerateBruteForce(sizes, constraints).length, 24);
});

test("table constraint count matches brute-force enumeration", () => {
  const sizes = [3, 3, 3];
  const constraints = [
    table([0, 1], [[0, 1], [1, 2], [2, 0]]),
    table([1, 2], [[0, 0], [1, 1], [2, 2]]),
  ];
  const solver = new Solver(sizes);
  for (const c of constraints) solver.addConstraint(c);
  const result = solver.solve("all");
  const expected = enumerateBruteForce(sizes, constraints);
  assert.equal(result.status, expected.length > 0 ? "sat" : "unsat");
  assert.equal(result.solutionCount, expected.length);
});

test("mixed allDifferent + table matches brute force on random instances", () => {
  // Deterministic pseudo-random generator (no external deps).
  let seed = 0x2f6e2b1;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let instance = 0; instance < 25; instance++) {
    const n = 2 + rand(4); // 2..5 variables
    const sizes = Array.from({ length: n }, () => 2 + rand(3)); // domains 2..4
    const constraints: Constraint[] = [];
    if (rand(2) === 0) constraints.push(allDifferent(...Array.from({ length: n }, (_, i) => i)));
    const a = rand(n);
    let b = rand(n);
    if (b === a) b = (b + 1) % n;
    const tuples: number[][] = [];
    const tupleCount = 1 + rand(3);
    for (let t = 0; t < tupleCount; t++) {
      tuples.push([rand(sizes[a]!), rand(sizes[b]!)]);
    }
    constraints.push(table([a, b], tuples));

    const solver = new Solver(sizes);
    for (const c of constraints) solver.addConstraint(c);
    const result = solver.solve("all");
    const expected = enumerateBruteForce(sizes, constraints);
    assert.equal(
      result.solutionCount,
      expected.length,
      `instance ${instance}: sizes=${sizes} constraints=${JSON.stringify(constraints)}`,
    );
    assert.equal(result.status, expected.length > 0 ? "sat" : "unsat");
  }
});

test("undoing branches restores all domains exactly", () => {
  const sizes = [4, 4, 4, 4];
  const constraints = [allDifferent(0, 1, 2, 3), table([0, 3], [[0, 3], [1, 2], [2, 1]])];
  const solver = new Solver(sizes);
  for (const c of constraints) solver.addConstraint(c);
  const before = solver.snapshotDomains();
  const result = solver.solve("all");
  assert.equal(result.status, "sat");
  const after = solver.snapshotDomains();
  assert.deepEqual(after, before);
});

test("unsatisfiable instance reports a complete infeasible tree", () => {
  // 3 vars, domain size 2, allDifferent -> impossible (pigeonhole).
  const sizes = [2, 2, 2];
  const constraints = [allDifferent(0, 1, 2)];
  const solver = new Solver(sizes);
  for (const c of constraints) solver.addConstraint(c);
  const result = solver.solve("all");
  assert.equal(result.status, "unsat");
  assert.equal(result.solutionCount, 0);
  assert.equal(result.frontier, 0);
  assert.ok(result.nodes >= 0);
  assert.equal(enumerateBruteForce(sizes, constraints).length, 0);
});

test("node budget yields an open frontier, larger budget closes it", () => {
  const sizes = [5, 5, 5, 5, 5];
  const constraints = [allDifferent(0, 1, 2, 3, 4)];

  const limited = new Solver(sizes);
  for (const c of constraints) limited.addConstraint(c);
  const partial = limited.solve("all", 3);
  assert.equal(partial.status, "unknown");
  assert.equal(partial.nodes, 3);
  assert.ok(partial.frontier > 0, "expected an open frontier");

  const full = new Solver(sizes);
  for (const c of constraints) full.addConstraint(c);
  const complete = full.solve("all");
  assert.equal(complete.status, "sat");
  assert.equal(complete.solutionCount, 120); // 5! permutations
  assert.equal(complete.frontier, 0);
  assert.ok(complete.nodes > partial.nodes);
});

test("budget of zero explores nothing and reports frontier", () => {
  const solver = new Solver([3, 3]);
  solver.addConstraint(allDifferent(0, 1));
  const result = solver.solve("all", 0);
  assert.equal(result.status, "unknown");
  assert.equal(result.nodes, 0);
  assert.ok(result.frontier > 0);
});

test("first-solution mode returns a valid solution", () => {
  const sizes = [4, 4, 4, 4];
  const constraints = [allDifferent(0, 1, 2, 3), table([1, 2], [[0, 1], [1, 2], [2, 3], [3, 0]])];
  const solver = new Solver(sizes);
  for (const c of constraints) solver.addConstraint(c);
  const result = solver.solve("first");
  assert.equal(result.status, "sat");
  assert.ok(result.solution !== null);
  assert.ok(isValidAssignment(result.solution!, sizes, constraints));
});

test("16-variable allDifferent solves quickly via propagation", () => {
  const sizes = new Array<number>(16).fill(16);
  const constraints = [allDifferent(...Array.from({ length: 16 }, (_, i) => i))];
  const solver = new Solver(sizes);
  for (const c of constraints) solver.addConstraint(c);
  const result = solver.solve("first");
  assert.equal(result.status, "sat");
  assert.ok(result.solution !== null);
  assert.ok(isValidAssignment(result.solution!, sizes, constraints));
  assert.ok(result.nodes <= 16, `expected <=16 nodes, got ${result.nodes}`);
});

test("GAC on table prunes unsupported values before search", () => {
  // x in {0,1,2}, y in {0,1,2}; table only allows (0,0) and (1,1).
  // Value 2 must be pruned from both domains by propagation alone.
  const solver = new Solver([3, 3]);
  solver.addConstraint(table([0, 1], [[0, 0], [1, 1]]));
  assert.ok(solver.propagate());
  assert.deepEqual(solver.domainOf(0), [0, 1]);
  assert.deepEqual(solver.domainOf(1), [0, 1]);
});

test("invalid constraints are rejected", () => {
  const solver = new Solver([2, 2]);
  assert.throws(() => solver.addConstraint(allDifferent(0, 5)), /unknown variable/);
  assert.throws(() => solver.addConstraint(table([0, 1], [[0]])), /arity/);
});
