"use strict";
/**
 * In-process CLI entry logic, separated from src/cli.ts so tests can run
 * the full pipeline without spawning a subprocess.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.USAGE = exports.EXIT_ERROR = exports.EXIT_UNSAT = exports.EXIT_SAT = void 0;
exports.parseArgs = parseArgs;
exports.runCli = runCli;
const parser_1 = require("./parser");
const solver_1 = require("./solver");
const verify_1 = require("./verify");
const format_1 = require("./format");
exports.EXIT_SAT = 0;
exports.EXIT_UNSAT = 1;
exports.EXIT_ERROR = 2;
exports.USAGE = `Usage: linsolve [problem-file] [--json] [--verify-limit N] [--no-verify]

Input format (one statement per line, '#' starts a comment):
  var x in [-100, 100]          variable with signed 64-bit closed interval domain
  2*x + 3 <= 15                 linear inequality (<=, <, >=, >, ==, !=)
  x % 7 == 3                    congruence (also: x == 3 (mod 7))

Output: minimal step intervals covering all solutions, or an UNSAT certificate.
All arithmetic is exact (bigint); strict inequalities never use floats.
After solving, the shrunk domain is verified exhaustively (up to --verify-limit
candidates, default ${verify_1.DEFAULT_VERIFY_LIMIT}) against the original constraints.

Exit codes: 0 = SAT, 1 = UNSAT, 2 = error.`;
function parseArgs(argv) {
    const opts = { json: false, verify: true, verifyLimit: verify_1.DEFAULT_VERIFY_LIMIT, help: false };
    let file = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json")
            opts.json = true;
        else if (arg === "--no-verify")
            opts.verify = false;
        else if (arg === "--verify-limit") {
            const raw = argv[++i];
            if (raw === undefined || !/^\d+$/.test(raw)) {
                throw new Error("--verify-limit expects a non-negative integer");
            }
            opts.verifyLimit = BigInt(raw);
        }
        else if (arg === "-h" || arg === "--help") {
            opts.help = true;
        }
        else if (arg.startsWith("-")) {
            throw new Error(`unknown option: ${arg}`);
        }
        else if (file === null) {
            file = arg;
        }
        else {
            throw new Error(`unexpected argument: ${arg}`);
        }
    }
    return { opts, file };
}
/** Run the solver on problem text; pure function of (argv, input). */
function runCli(argv, input) {
    try {
        const { opts } = parseArgs(argv);
        if (opts.help)
            return { code: exports.EXIT_SAT, out: exports.USAGE + "\n", err: "" };
        const problem = (0, parser_1.parseProblem)(input);
        const result = (0, solver_1.solveProblem)(problem);
        const verifications = opts.verify && result.certificate === null
            ? (0, verify_1.verifyProblem)(problem, result, opts.verifyLimit)
            : null;
        const out = (opts.json ? (0, format_1.formatJson)(result, verifications) : (0, format_1.formatHuman)(result, verifications)) + "\n";
        if (verifications && verifications.some((v) => !v.ok)) {
            return { code: exports.EXIT_ERROR, out, err: "verification failed\n" };
        }
        return { code: result.status === "sat" ? exports.EXIT_SAT : exports.EXIT_UNSAT, out, err: "" };
    }
    catch (err) {
        return { code: exports.EXIT_ERROR, out: "", err: `error: ${err instanceof Error ? err.message : String(err)}\n` };
    }
}
