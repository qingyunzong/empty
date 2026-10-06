#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseInput } from "./parse";
import {
  DEFAULT_BUDGET,
  DEFAULT_REFINE_BITS,
  resultToJson,
  solveCurveLine,
} from "./solve";

function usage(): never {
  console.error(
    "usage: curve-roots <input.json> [--budget N] [--refine-bits N]",
  );
  process.exit(2);
}

export function runCli(argv: string[]): string {
  let file: string | undefined;
  let budget = DEFAULT_BUDGET;
  let refineBits = DEFAULT_REFINE_BITS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--budget") {
      budget = parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(budget) || budget < 0) usage();
    } else if (arg === "--refine-bits") {
      refineBits = parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(refineBits) || refineBits < 0) usage();
    } else if (arg.startsWith("--")) {
      usage();
    } else if (file === undefined) {
      file = arg;
    } else {
      usage();
    }
  }
  if (file === undefined) usage();

  const json: unknown = JSON.parse(readFileSync(file, "utf8"));
  const { line, segments } = parseInput(json);
  const result = solveCurveLine(line, segments, { budget, refineBits });
  return JSON.stringify(resultToJson(result), null, 2);
}

if (typeof require !== "undefined" && require.main === module) {
  try {
    console.log(runCli(process.argv.slice(2)));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
