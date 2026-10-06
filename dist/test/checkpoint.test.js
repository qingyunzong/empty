"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const solver_1 = require("../src/solver");
const DIR = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'tier-allocator-test');
(0, node_fs_1.mkdirSync)(DIR, { recursive: true });
const problem = {
    users: 10,
    tiers: [
        { r1: 3, r2: 2, benefit: 4 },
        { r1: 5, r2: 3, benefit: 9 },
        { r1: 8, r2: 5, benefit: 15 },
    ],
    budget1: 22,
    budget2: 15,
    pairBonuses: [
        { i: 0, j: 3, a: 2, b: 2, bonus: 6 },
        { i: 1, j: 2, a: 1, b: 0, bonus: 3 },
        { i: 4, j: 7, a: 0, b: 1, bonus: -2 },
        { i: 5, j: 6, a: 2, b: 2, bonus: 5 },
    ],
    constraints: [
        { kind: 'same', i: 0, j: 3 },
        { kind: 'diff', i: 1, j: 2 },
        { kind: 'diff', i: 8, j: 9 },
    ],
};
function tmpFile(name) {
    return (0, node_path_1.join)(DIR, name);
}
(0, node_test_1.test)('pause/save/restore produces the identical result and node count', () => {
    const full = new solver_1.Solver(problem);
    full.run();
    const expected = full.getBest();
    const file = tmpFile('cp1.json');
    if ((0, node_fs_1.existsSync)(file))
        (0, node_fs_1.rmSync)(file);
    // 每次最多推进 37 个节点就暂停、保存、从文件恢复为新实例。
    let solver = new solver_1.Solver(problem);
    let pauses = 0;
    while (!solver.isDone) {
        solver.run(solver.nodeCount + 37);
        solver.saveToFile(problem, file);
        solver = solver_1.Solver.loadFromFile(problem, file);
        pauses++;
        (0, strict_1.ok)(pauses < 100000, 'too many pauses, something is wrong');
    }
    (0, strict_1.ok)(pauses > 1, 'expected the run to actually pause at least once');
    (0, strict_1.equal)(solver.nodeCount, full.nodeCount, 'node count must match uninterrupted run');
    (0, strict_1.deepEqual)(solver.getBest(), expected);
});
(0, node_test_1.test)('in-memory checkpoint round-trip equals uninterrupted run', () => {
    const full = new solver_1.Solver(problem);
    full.run();
    let solver = new solver_1.Solver(problem);
    let budget = 1;
    while (!solver.isDone) {
        solver.run(solver.nodeCount + budget);
        budget = budget * 3 + 1;
        solver = solver_1.Solver.fromCheckpoint(problem, solver.toCheckpoint(problem));
    }
    (0, strict_1.equal)(solver.nodeCount, full.nodeCount);
    (0, strict_1.deepEqual)(solver.getBest(), full.getBest());
});
(0, node_test_1.test)('checkpoint file is valid JSON with complete search state', () => {
    const file = tmpFile('cp2.json');
    const solver = new solver_1.Solver(problem);
    solver.run(10);
    solver.saveToFile(problem, file);
    const cp = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf8'));
    (0, strict_1.equal)(cp.version, 1);
    (0, strict_1.ok)(typeof cp.problem === 'string' && cp.problem.length > 0);
    (0, strict_1.ok)(Array.isArray(cp.stack) && Array.isArray(cp.choices));
    (0, strict_1.ok)(typeof cp.nodes === 'number' && cp.nodes === 10);
    (0, strict_1.equal)(cp.done, false);
});
(0, node_test_1.test)('restoring with a different problem is rejected', () => {
    const file = tmpFile('cp3.json');
    const solver = new solver_1.Solver(problem);
    solver.run(5);
    solver.saveToFile(problem, file);
    const other = { ...problem, budget1: problem.budget1 + 1 };
    (0, strict_1.throws)(() => solver_1.Solver.loadFromFile(other, file));
});
(0, node_test_1.test)('running a finished solver is a no-op', () => {
    const solver = new solver_1.Solver(problem);
    solver.run();
    const nodes = solver.nodeCount;
    solver.run();
    (0, strict_1.equal)(solver.nodeCount, nodes);
});
