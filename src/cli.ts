import { readFileSync } from "node:fs";
import { buildGraph } from "./graph";
import { solve } from "./solver";

const USAGE = [
  "usage: path-cli <graph.json>",
  "",
  "Finds a simple path (no repeated nodes) from start to end that visits at",
  "most maxNodes nodes (default 12) and covers every checkpoint. Among all",
  "feasible paths it minimizes, in order: maximum edge cost, total cost,",
  "then the node-id sequence. Prints the witness path as JSON to stdout.",
  "",
  "input format:",
  '{ "nodes": ["A","B"], "edges": [{"from":"A","to":"B","cost":3}],',
  '  "start": "A", "end": "B", "checkpoints": [], "maxNodes": 12,',
  '  "directed": false }',
  "",
  "exit codes: 0 = path found, 1 = no feasible path, 2 = usage/input error",
].join("\n");

export function run(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.length !== 1) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(args[0], "utf8"));
  } catch (err) {
    process.stderr.write(`error: cannot read or parse ${args[0]}: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const witness = solve(buildGraph(input));
    process.stdout.write(JSON.stringify(witness, null, 2) + "\n");
    return witness.found ? 0 : 1;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv);
}
