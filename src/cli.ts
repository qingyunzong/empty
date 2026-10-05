#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { MAX_AMOUNT, parseProblem, InputError } from "./model";
import { solve, NegativeCycleError } from "./solver";
import { bruteForce, ENUMERATION_LIMIT } from "./brute";

const USAGE = `Usage: transfer <input.json | -> [options]

Reads a transfer problem (JSON) and prints the minimum-cost integer flow
together with a residual-potential optimality certificate.

Input format:
{
  "source": "A",                 // source account
  "sink":   "D",                 // target account
  "amount": 5,                   // integer units to send, 0..${MAX_AMOUNT}
  "edges": [
    { "from": "A", "to": "B",
      "segments": [ { "capacity": 3, "cost": 2 },   // piecewise fee curve,
                    { "capacity": 2, "cost": 5 } ] } // non-decreasing cost
  ]
}

Options:
  --amount N   override "amount" from the input file (integer 0..${MAX_AMOUNT})
  --brute      cross-check against brute-force enumeration (small networks
               only, search space <= ${ENUMERATION_LIMIT})
  -h, --help   show this help

Exit codes: 0 = optimal flow found, 1 = requested amount infeasible,
            2 = invalid input (including negative-cost cycles).`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
  throw new Exit();
}

class Exit extends Error {}

function main(argv: string[]): void {
  const args = argv.slice(2);
  let inputPath: string | null = null;
  let amountOverride: number | null = null;
  let useBrute = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE + "\n");
      return;
    } else if (a === "--brute") {
      useBrute = true;
    } else if (a === "--amount") {
      const v = args[++i];
      if (v === undefined || !/^-?\d+$/.test(v)) fail("--amount requires an integer");
      amountOverride = Number(v);
    } else if (a.startsWith("-") && a !== "-") {
      fail(`unknown option: ${a}`);
    } else if (inputPath === null) {
      inputPath = a;
    } else {
      fail(`unexpected argument: ${a}`);
    }
  }

  if (inputPath === null) fail("missing input file (use - for stdin, or --help)");

  let text: string;
  try {
    text = readFileSync(inputPath === "-" ? process.stdin.fd : inputPath, "utf8");
  } catch {
    fail(`cannot read ${inputPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text!);
  } catch (e) {
    fail(`invalid JSON: ${(e as Error).message}`);
  }

  let problem;
  try {
    problem = parseProblem(raw);
  } catch (e) {
    if (e instanceof InputError) fail(e.message);
    throw e;
  }

  if (amountOverride !== null) {
    if (amountOverride < 0 || amountOverride > MAX_AMOUNT)
      fail(`--amount must be in [0, ${MAX_AMOUNT}]`);
    problem = { ...problem, amount: amountOverride };
  }

  let result;
  try {
    result = solve(problem);
  } catch (e) {
    if (e instanceof NegativeCycleError) fail(e.message);
    throw e;
  }

  const output: Record<string, unknown> = { ...result };

  if (useBrute) {
    const brute = bruteForce(problem);
    const agree =
      brute.status === result.status &&
      (brute.status === "infeasible" || brute.minCost === result.minCost);
    output.bruteForce = { ...brute, agreesWithSolver: agree };
    if (!agree) {
      process.stderr.write("error: solver and brute force disagree\n");
      process.exitCode = 3;
    }
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  if (result.status === "infeasible") process.exitCode = 1;
}

try {
  main(process.argv);
} catch (e) {
  if (!(e instanceof Exit)) throw e;
}
