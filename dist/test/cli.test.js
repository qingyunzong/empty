"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const cli_1 = require("../src/cli");
const SAMPLE = {
    start: "A",
    end: "F",
    checkpoints: ["D"],
    edges: [
        { from: "A", to: "B", cost: 2 },
        { from: "B", to: "D", cost: 2 },
        { from: "D", to: "F", cost: 2 },
        { from: "A", to: "C", cost: 1 },
        { from: "C", to: "F", cost: 1 },
        { from: "A", to: "D", cost: 9 },
    ],
};
// Runs the CLI in-process (the sandbox forbids spawning child processes),
// capturing everything it prints.
function runCli(argv, stdin) {
    const logs = [];
    const errors = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (msg) => logs.push(String(msg));
    console.error = (msg) => errors.push(String(msg));
    try {
        const code = (0, cli_1.run)(argv, () => stdin ?? "");
        return { code, out: logs.join("\n"), err: errors.join("\n") };
    }
    finally {
        console.log = origLog;
        console.error = origError;
    }
}
(0, node_test_1.test)("CLI reads a spec file and prints the witness", () => {
    const file = (0, node_path_1.join)((0, node_os_1.tmpdir)(), "path-cli-sample.json");
    (0, node_fs_1.writeFileSync)(file, JSON.stringify(SAMPLE));
    const { code, out } = runCli([file]);
    strict_1.default.equal(code, 0);
    const parsed = JSON.parse(out);
    strict_1.default.equal(parsed.found, true);
    // A-B-D-F: max edge 2, total 6; A-D-F has max edge 9; A-C-F skips checkpoint D.
    strict_1.default.deepEqual(parsed.witness, {
        path: ["A", "B", "D", "F"],
        nodeCount: 4,
        maxEdgeCost: 2,
        totalCost: 6,
    });
    strict_1.default.equal(parsed.stats.simplePaths, 3);
    strict_1.default.equal(parsed.stats.feasiblePaths, 2);
});
(0, node_test_1.test)("CLI reads the spec from stdin", () => {
    const { code, out } = runCli(["--compact"], JSON.stringify(SAMPLE));
    strict_1.default.equal(code, 0);
    const parsed = JSON.parse(out);
    strict_1.default.deepEqual(parsed.witness.path, ["A", "B", "D", "F"]);
});
(0, node_test_1.test)("CLI overrides max-nodes and checkpoints from flags", () => {
    const { code, out } = runCli(["--compact", "--max-nodes", "3", "--checkpoints", "D"], JSON.stringify(SAMPLE));
    strict_1.default.equal(code, 0);
    const parsed = JSON.parse(out);
    strict_1.default.deepEqual(parsed.witness.path, ["A", "D", "F"]); // 4-node path now excluded
    strict_1.default.equal(parsed.witness.maxEdgeCost, 9);
});
(0, node_test_1.test)("CLI exits 1 with found=false when no feasible path exists", () => {
    const infeasible = { ...SAMPLE, maxNodes: 2 };
    const { code, out } = runCli(["--compact"], JSON.stringify(infeasible));
    strict_1.default.equal(code, 1);
    const parsed = JSON.parse(out);
    strict_1.default.equal(parsed.found, false);
    strict_1.default.equal(parsed.witness, null);
});
(0, node_test_1.test)("CLI exits 2 on invalid JSON and on bad options", () => {
    strict_1.default.equal(runCli([], "not json").code, 2);
    strict_1.default.equal(runCli(["--max-nodes", "zero"], "{}").code, 2);
    strict_1.default.equal(runCli(["--nope"], "{}").code, 2);
});
