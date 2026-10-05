import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { loadGraphFile, DEFAULT_MAX_LENGTH } from "./model.js";
import { findPath } from "./pathfinder.js";
const USAGE = `Usage: certpath <input.json> --leaf <id> --usage <usage> [--max-length <n>] [--json]

Validates a certificate path offline against a local relationship graph with
explicit per-certificate verification results.

Input JSON format:
  {
    "certificates": [{ "id": "leaf", "issuers": ["ca"], "usages": ["serverAuth"] }],
    "validity": { "leaf": true, "ca": true },
    "trustedRoots": ["root"]
  }

Path rules: every certificate valid, every certificate allows the requested
usage, the chain ends at a trusted root, at most ${DEFAULT_MAX_LENGTH} certificates
(configurable with --max-length). Among valid paths the shortest wins, ties
are broken by certificate id order.

Exit codes: 0 = path found, 1 = no valid path, 2 = bad invocation or input.
`;
function printResult(result, asJson, io) {
    if (asJson) {
        const payload = result.ok
            ? { ok: true, path: result.path }
            : { ok: false, failure: result.failure };
        io.out(JSON.stringify(payload, null, 2) + "\n");
    }
    else if (result.ok) {
        io.out(`OK path (${result.path.length} certificates): ${result.path.join(" -> ")}\n`);
    }
    else {
        io.out(`FAIL [${result.failure.code}] ${result.failure.message}\n`);
    }
    return result.ok ? 0 : 1;
}
export function run(argv, io) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            strict: true,
            options: {
                leaf: { type: "string" },
                usage: { type: "string" },
                "max-length": { type: "string", default: String(DEFAULT_MAX_LENGTH) },
                json: { type: "boolean", default: false },
                help: { type: "boolean", default: false },
            },
        });
    }
    catch (error) {
        io.err(`${error.message}\n${USAGE}`);
        return 2;
    }
    if (parsed.values.help === true) {
        io.out(USAGE);
        return 0;
    }
    const [inputPath] = parsed.positionals;
    const leaf = parsed.values.leaf;
    const usage = parsed.values.usage;
    const maxLengthRaw = parsed.values["max-length"];
    const maxLength = Number(maxLengthRaw);
    if (inputPath === undefined || typeof leaf !== "string" || typeof usage !== "string") {
        io.err(`missing required arguments\n${USAGE}`);
        return 2;
    }
    if (!Number.isInteger(maxLength) || maxLength < 1) {
        io.err(`--max-length must be a positive integer, got "${String(maxLengthRaw)}"\n`);
        return 2;
    }
    let graph;
    try {
        graph = loadGraphFile(inputPath);
    }
    catch (error) {
        io.err(`${error.message}\n`);
        return 2;
    }
    const result = findPath(graph, { leafId: leaf, usage, maxLength });
    return printResult(result, parsed.values.json === true, io);
}
const invokedAsMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsMain) {
    process.exitCode = run(process.argv.slice(2), {
        out: (chunk) => process.stdout.write(chunk),
        err: (chunk) => process.stderr.write(chunk),
    });
}
