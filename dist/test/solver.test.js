"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const solver_1 = require("../src/solver");
function isValidAssignment(assignment, domainSizes, constraints) {
    for (let v = 0; v < assignment.length; v++) {
        if (assignment[v] < 0 || assignment[v] >= domainSizes[v])
            return false;
    }
    for (const c of constraints) {
        if (c.kind === "allDifferent") {
            const seen = new Set();
            for (const v of c.scope) {
                if (seen.has(assignment[v]))
                    return false;
                seen.add(assignment[v]);
            }
        }
        else {
            const row = c.scope.map((v) => assignment[v]);
            if (!c.tuples.some((t) => t.every((x, i) => x === row[i])))
                return false;
        }
    }
    return true;
}
(0, node_test_1.test)("rejects more than 16 variables", () => {
    strict_1.default.throws(() => new solver_1.Solver(new Array(solver_1.MAX_VARS + 1).fill(2)), /at most 16/);
    strict_1.default.ok(new solver_1.Solver(new Array(solver_1.MAX_VARS).fill(2)));
});
(0, node_test_1.test)("allDifferent over 4 vars/domain 4 yields all 24 permutations", () => {
    const sizes = [4, 4, 4, 4];
    const constraints = [(0, solver_1.allDifferent)(0, 1, 2, 3)];
    const solver = new solver_1.Solver(sizes);
    for (const c of constraints)
        solver.addConstraint(c);
    const result = solver.solve("all");
    strict_1.default.equal(result.status, "sat");
    strict_1.default.equal(result.solutionCount, 24);
    strict_1.default.equal(result.frontier, 0);
    // Independent cross-check.
    strict_1.default.equal((0, solver_1.enumerateBruteForce)(sizes, constraints).length, 24);
});
(0, node_test_1.test)("table constraint count matches brute-force enumeration", () => {
    const sizes = [3, 3, 3];
    const constraints = [
        (0, solver_1.table)([0, 1], [[0, 1], [1, 2], [2, 0]]),
        (0, solver_1.table)([1, 2], [[0, 0], [1, 1], [2, 2]]),
    ];
    const solver = new solver_1.Solver(sizes);
    for (const c of constraints)
        solver.addConstraint(c);
    const result = solver.solve("all");
    const expected = (0, solver_1.enumerateBruteForce)(sizes, constraints);
    strict_1.default.equal(result.status, expected.length > 0 ? "sat" : "unsat");
    strict_1.default.equal(result.solutionCount, expected.length);
});
(0, node_test_1.test)("mixed allDifferent + table matches brute force on random instances", () => {
    // Deterministic pseudo-random generator (no external deps).
    let seed = 0x2f6e2b1;
    const rand = (n) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
    };
    for (let instance = 0; instance < 25; instance++) {
        const n = 2 + rand(4); // 2..5 variables
        const sizes = Array.from({ length: n }, () => 2 + rand(3)); // domains 2..4
        const constraints = [];
        if (rand(2) === 0)
            constraints.push((0, solver_1.allDifferent)(...Array.from({ length: n }, (_, i) => i)));
        const a = rand(n);
        let b = rand(n);
        if (b === a)
            b = (b + 1) % n;
        const tuples = [];
        const tupleCount = 1 + rand(3);
        for (let t = 0; t < tupleCount; t++) {
            tuples.push([rand(sizes[a]), rand(sizes[b])]);
        }
        constraints.push((0, solver_1.table)([a, b], tuples));
        const solver = new solver_1.Solver(sizes);
        for (const c of constraints)
            solver.addConstraint(c);
        const result = solver.solve("all");
        const expected = (0, solver_1.enumerateBruteForce)(sizes, constraints);
        strict_1.default.equal(result.solutionCount, expected.length, `instance ${instance}: sizes=${sizes} constraints=${JSON.stringify(constraints)}`);
        strict_1.default.equal(result.status, expected.length > 0 ? "sat" : "unsat");
    }
});
(0, node_test_1.test)("undoing branches restores all domains exactly", () => {
    const sizes = [4, 4, 4, 4];
    const constraints = [(0, solver_1.allDifferent)(0, 1, 2, 3), (0, solver_1.table)([0, 3], [[0, 3], [1, 2], [2, 1]])];
    const solver = new solver_1.Solver(sizes);
    for (const c of constraints)
        solver.addConstraint(c);
    const before = solver.snapshotDomains();
    const result = solver.solve("all");
    strict_1.default.equal(result.status, "sat");
    const after = solver.snapshotDomains();
    strict_1.default.deepEqual(after, before);
});
(0, node_test_1.test)("unsatisfiable instance reports a complete infeasible tree", () => {
    // 3 vars, domain size 2, allDifferent -> impossible (pigeonhole).
    const sizes = [2, 2, 2];
    const constraints = [(0, solver_1.allDifferent)(0, 1, 2)];
    const solver = new solver_1.Solver(sizes);
    for (const c of constraints)
        solver.addConstraint(c);
    const result = solver.solve("all");
    strict_1.default.equal(result.status, "unsat");
    strict_1.default.equal(result.solutionCount, 0);
    strict_1.default.equal(result.frontier, 0);
    strict_1.default.ok(result.nodes >= 0);
    strict_1.default.equal((0, solver_1.enumerateBruteForce)(sizes, constraints).length, 0);
});
(0, node_test_1.test)("node budget yields an open frontier, larger budget closes it", () => {
    const sizes = [5, 5, 5, 5, 5];
    const constraints = [(0, solver_1.allDifferent)(0, 1, 2, 3, 4)];
    const limited = new solver_1.Solver(sizes);
    for (const c of constraints)
        limited.addConstraint(c);
    const partial = limited.solve("all", 3);
    strict_1.default.equal(partial.status, "unknown");
    strict_1.default.equal(partial.nodes, 3);
    strict_1.default.ok(partial.frontier > 0, "expected an open frontier");
    const full = new solver_1.Solver(sizes);
    for (const c of constraints)
        full.addConstraint(c);
    const complete = full.solve("all");
    strict_1.default.equal(complete.status, "sat");
    strict_1.default.equal(complete.solutionCount, 120); // 5! permutations
    strict_1.default.equal(complete.frontier, 0);
    strict_1.default.ok(complete.nodes > partial.nodes);
});
(0, node_test_1.test)("budget of zero explores nothing and reports frontier", () => {
    const solver = new solver_1.Solver([3, 3]);
    solver.addConstraint((0, solver_1.allDifferent)(0, 1));
    const result = solver.solve("all", 0);
    strict_1.default.equal(result.status, "unknown");
    strict_1.default.equal(result.nodes, 0);
    strict_1.default.ok(result.frontier > 0);
});
(0, node_test_1.test)("first-solution mode returns a valid solution", () => {
    const sizes = [4, 4, 4, 4];
    const constraints = [(0, solver_1.allDifferent)(0, 1, 2, 3), (0, solver_1.table)([1, 2], [[0, 1], [1, 2], [2, 3], [3, 0]])];
    const solver = new solver_1.Solver(sizes);
    for (const c of constraints)
        solver.addConstraint(c);
    const result = solver.solve("first");
    strict_1.default.equal(result.status, "sat");
    strict_1.default.ok(result.solution !== null);
    strict_1.default.ok(isValidAssignment(result.solution, sizes, constraints));
});
(0, node_test_1.test)("16-variable allDifferent solves quickly via propagation", () => {
    const sizes = new Array(16).fill(16);
    const constraints = [(0, solver_1.allDifferent)(...Array.from({ length: 16 }, (_, i) => i))];
    const solver = new solver_1.Solver(sizes);
    for (const c of constraints)
        solver.addConstraint(c);
    const result = solver.solve("first");
    strict_1.default.equal(result.status, "sat");
    strict_1.default.ok(result.solution !== null);
    strict_1.default.ok(isValidAssignment(result.solution, sizes, constraints));
    strict_1.default.ok(result.nodes <= 16, `expected <=16 nodes, got ${result.nodes}`);
});
(0, node_test_1.test)("GAC on table prunes unsupported values before search", () => {
    // x in {0,1,2}, y in {0,1,2}; table only allows (0,0) and (1,1).
    // Value 2 must be pruned from both domains by propagation alone.
    const solver = new solver_1.Solver([3, 3]);
    solver.addConstraint((0, solver_1.table)([0, 1], [[0, 0], [1, 1]]));
    strict_1.default.ok(solver.propagate());
    strict_1.default.deepEqual(solver.domainOf(0), [0, 1]);
    strict_1.default.deepEqual(solver.domainOf(1), [0, 1]);
});
(0, node_test_1.test)("invalid constraints are rejected", () => {
    const solver = new solver_1.Solver([2, 2]);
    strict_1.default.throws(() => solver.addConstraint((0, solver_1.allDifferent)(0, 5)), /unknown variable/);
    strict_1.default.throws(() => solver.addConstraint((0, solver_1.table)([0, 1], [[0]])), /arity/);
});
