#!/usr/bin/env node
/**
 * binpack CLI.
 *
 * Usage:
 *   binpack [--verify] [input.json]
 *
 * Input is JSON read from the given file, or from stdin when omitted:
 *   {
 *     "capacity": 10,
 *     "items": [{ "id": 1, "size": 4, "group": "a" }, ...],
 *     "forbidden": [[1, 2], ...]
 *   }
 *
 * Output (JSON on stdout):
 *   {
 *     "binCount": 2,
 *     "loads": [7, 5],                 // canonical order (by min item id per bin)
 *     "bins": [[1, 3], [2, 4]],        // bin 1 holds the smallest item id
 *     "assignment": { "1": 1, ... }    // normalized 1-based bin number per item
 *   }
 *
 * --verify additionally re-solves the instance by enumerating all set
 * partitions (small instances only) and fails if the results differ.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bruteForce, BRUTE_FORCE_MAX_ITEMS } from "./brute.js";
import { InfeasibleError, Problem, Solution, solve } from "./solver.js";

const USAGE = `usage: binpack [--verify] [input.json]
  reads JSON from input.json, or stdin when no file is given`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Pure CLI logic, testable in-process. `readStdin` supplies stdin content. */
export function runCli(args: string[], readStdin: () => string): CliResult {
  let verify = false;
  let file: string | null = null;
  for (const arg of args) {
    if (arg === "--verify") verify = true;
    else if (arg === "-h" || arg === "--help") {
      return { code: 0, stdout: USAGE + "\n", stderr: "" };
    } else if (file === null) file = arg;
    else {
      return { code: 2, stdout: "", stderr: `unexpected argument: ${arg}\n${USAGE}\n` };
    }
  }

  let raw: string;
  try {
    raw = file === null ? readStdin() : readFileSync(file, "utf8");
  } catch (err) {
    return { code: 2, stdout: "", stderr: `failed to read input: ${(err as Error).message}\n` };
  }

  let problem: Problem;
  try {
    problem = JSON.parse(raw) as Problem;
  } catch (err) {
    return { code: 2, stdout: "", stderr: `invalid JSON input: ${(err as Error).message}\n` };
  }

  let solution: Solution;
  try {
    solution = solve(problem);
  } catch (err) {
    if (err instanceof InfeasibleError) {
      return { code: 1, stdout: "", stderr: `infeasible: ${err.message}\n` };
    }
    return { code: 2, stdout: "", stderr: `error: ${(err as Error).message}\n` };
  }

  let stderr = "";
  if (verify) {
    if (problem.items.length > BRUTE_FORCE_MAX_ITEMS) {
      stderr +=
        `verify: skipped (instance has ${problem.items.length} items, ` +
        `limit is ${BRUTE_FORCE_MAX_ITEMS})\n`;
    } else {
      const expected = bruteForce(problem);
      const same =
        expected.binCount === solution.binCount &&
        JSON.stringify(expected.loads) === JSON.stringify(solution.loads) &&
        JSON.stringify(expected.bins) === JSON.stringify(solution.bins);
      if (!same) {
        stderr +=
          `verify: MISMATCH\n  solver:      ${JSON.stringify(solution)}\n` +
          `  brute force: ${JSON.stringify(expected)}\n`;
        return { code: 1, stdout: "", stderr };
      }
      stderr += `verify: ok (partition enumeration agrees, ${solution.binCount} bins)\n`;
    }
  }

  return { code: 0, stdout: JSON.stringify(solution, null, 2) + "\n", stderr };
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const result = runCli(process.argv.slice(2), () => readFileSync(0, "utf8"));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
