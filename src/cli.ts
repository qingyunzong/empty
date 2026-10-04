import { readFileSync } from "node:fs";
import process from "node:process";
import { buildDag } from "./dag.js";
import type { DagInput } from "./dag.js";
import { fromMap } from "./oracle.js";
import type { ScriptedVerdict } from "./oracle.js";
import { findBoundary } from "./bisect.js";
import { scanFullDag, crossCheck } from "./verify.js";

interface CliInput extends DagInput {
  oracle: Record<string, ScriptedVerdict>;
}

function parseArgs(argv: string[]): { file: string; budget: number } {
  let file: string | undefined;
  let budget = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--budget") {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error("--budget requires a value");
      budget = Number.parseInt(raw, 10);
      i += 1;
    } else if (file === undefined) {
      file = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (file === undefined) {
    throw new Error("usage: node dist/src/cli.js <input.json> [--budget N]");
  }
  return { file, budget };
}

async function main(): Promise<void> {
  const { file, budget } = parseArgs(process.argv.slice(2));
  const input = JSON.parse(readFileSync(file, "utf8")) as CliInput;
  const dag = buildDag({ nodes: input.nodes, edges: input.edges });
  const oracle = fromMap(input.oracle);

  const bounded = await findBoundary(dag, oracle, budget);
  const full = await scanFullDag(dag, oracle);
  const check = crossCheck(dag, bounded, full);

  const output = { bounded, fullBoundary: full.boundary, fullStatus: full.status, crossCheck: check };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!check.ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
});
