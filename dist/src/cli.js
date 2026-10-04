"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const node_fs_1 = require("node:fs");
const graph_1 = require("./graph");
const solver_1 = require("./solver");
const USAGE = `Usage: path-cli [options] [input.json]

Reads a graph spec as JSON (from a file argument, or stdin when omitted) and
prints the best feasible path as a JSON witness.

Spec fields:
  start, end     node IDs (strings, required)
  edges          [{ "from": "A", "to": "B", "cost": 3 }, ...] (required)
  checkpoints    node IDs that must all be visited (default [])
  maxNodes       max visited nodes per path (default 12)
  directed       treat edges as one-way (default false)

Objective (lexicographic priority):
  1. minimize the maximum edge cost on the path (bottleneck)
  2. minimize the total edge cost
  3. minimize the path ID sequence (natural order, e.g. N2 < N10)

Options:
  --max-nodes N       override spec maxNodes
  --checkpoints A,B   override spec checkpoints
  --directed          force directed edges
  --undirected        force undirected edges
  --compact           single-line JSON output
  -h, --help          show this help

Exit codes: 0 = path found, 1 = no feasible path, 2 = usage/input error.`;
function parseArgs(argv) {
    const options = { file: null, compact: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-h" || arg === "--help") {
            console.log(USAGE);
            process.exitCode = 0;
            return { ...options, file: null, maxNodes: -1 }; // sentinel: handled by caller
        }
        else if (arg === "--max-nodes") {
            const value = argv[++i];
            const n = value === undefined ? NaN : Number(value);
            if (!Number.isInteger(n) || n < 1)
                throw new Error("--max-nodes needs an integer >= 1");
            options.maxNodes = n;
        }
        else if (arg === "--checkpoints") {
            const value = argv[++i];
            if (value === undefined)
                throw new Error("--checkpoints needs a comma-separated list");
            options.checkpoints = value.split(",").filter((s) => s.length > 0);
        }
        else if (arg === "--directed") {
            options.directed = true;
        }
        else if (arg === "--undirected") {
            options.directed = false;
        }
        else if (arg === "--compact") {
            options.compact = true;
        }
        else if (arg.startsWith("-")) {
            throw new Error(`unknown option: ${arg}`);
        }
        else if (options.file === null) {
            options.file = arg;
        }
        else {
            throw new Error(`unexpected extra argument: ${arg}`);
        }
    }
    return options;
}
function run(argv, readStdin = () => (0, node_fs_1.readFileSync)(0, "utf8")) {
    let options;
    try {
        options = parseArgs(argv);
    }
    catch (err) {
        console.error(`error: ${err.message}\n`);
        console.error(USAGE);
        return 2;
    }
    if (options.maxNodes === -1)
        return 0; // --help was printed
    let rawText;
    try {
        rawText = options.file === null ? readStdin() : (0, node_fs_1.readFileSync)(options.file, "utf8");
    }
    catch (err) {
        console.error(`error: cannot read input: ${err.message}`);
        return 2;
    }
    let raw;
    try {
        raw = JSON.parse(rawText);
    }
    catch (err) {
        console.error(`error: invalid JSON: ${err.message}`);
        return 2;
    }
    const overrides = {};
    if (options.maxNodes !== undefined)
        overrides.maxNodes = options.maxNodes;
    if (options.checkpoints !== undefined)
        overrides.checkpoints = options.checkpoints;
    if (options.directed !== undefined)
        overrides.directed = options.directed;
    let spec;
    try {
        spec = (0, graph_1.normalizeSpec)({ ...raw, ...overrides });
    }
    catch (err) {
        console.error(`error: ${err.message}`);
        return 2;
    }
    const result = (0, solver_1.solve)(spec);
    const witness = {
        found: result.found,
        witness: result.best
            ? {
                path: result.best.nodes,
                nodeCount: result.best.nodes.length,
                maxEdgeCost: result.best.maxEdgeCost,
                totalCost: result.best.totalCost,
            }
            : null,
        stats: {
            simplePaths: result.simplePathCount,
            feasiblePaths: result.feasiblePathCount,
        },
    };
    console.log(options.compact ? JSON.stringify(witness) : JSON.stringify(witness, null, 2));
    return result.found ? 0 : 1;
}
if (require.main === module) {
    process.exitCode = run(process.argv.slice(2));
}
