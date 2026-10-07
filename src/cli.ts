#!/usr/bin/env node
/**
 * linsolve — exact solver for linear inequalities and congruences over
 * signed 64-bit integer domains. See USAGE in src/app.ts.
 *
 * Exit codes: 0 = SAT, 1 = UNSAT, 2 = error (parse/usage/verification).
 */

import { readFileSync } from "node:fs";
import { parseArgs, runCli } from "./app";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk as string;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => reject(new Error("failed to read stdin")));
  });
}

async function main(): Promise<void> {
  let input: string;
  let argv: string[];
  try {
    const { file } = parseArgs(process.argv.slice(2));
    argv = process.argv.slice(2);
    input = file !== null ? readFileSync(file, "utf8") : await readStdin();
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  const result = runCli(argv, input);
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exitCode = result.code;
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});
