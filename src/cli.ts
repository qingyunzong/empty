import { readFileSync } from "node:fs";
import { parseProblem, MAX_CANDIDATES, Problem } from "./model.js";
import {
  buildEvidence,
  solveBranchAndBound,
  solveBruteForce,
  SolveResult,
} from "./solver.js";

export interface CliIO {
  readInput(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultIO: CliIO = {
  readInput: (path) =>
    path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8"),
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
};

interface CliArgs {
  inputPath: string;
  json: boolean;
}

function usage(): string {
  return [
    "Usage: perm-solve <input.json | -> [--json]",
    "",
    "Input JSON:",
    '  { "candidates": [{ "id", "action": "allow"|"deny", "cost",',
    '                     "match": { "subject", "op", "resource" } }],',
    '    "samples":    [{ "id", "expect": "allow"|"deny",',
    '                     "request": { "subject", "op", "resource" } }] }',
    "",
    `At most ${MAX_CANDIDATES} candidates. Deny rules win conflicts. Default decision is deny.`,
    "Exit codes: 0 = optimal subset found and verified, 1 = infeasible, 2 = invalid input.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs | "help" {
  let inputPath: string | null = null;
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      return "help";
    } else if (inputPath === null) {
      inputPath = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (inputPath === null) {
    throw new Error("missing input file path (use - for stdin)");
  }
  return { inputPath, json };
}

function formatMask(mask: number, count: number): string {
  const bits: string[] = [];
  for (let i = 0; i < count; i++) {
    bits.push((mask & (1 << i)) !== 0 ? "1" : "0");
  }
  return bits.reverse().join("");
}

function renderText(
  problem: Problem,
  bnb: SolveResult,
  brute: SolveResult,
): string {
  const lines: string[] = [];
  const n = problem.candidates.length;
  if (!bnb.feasible) {
    lines.push("Status: INFEASIBLE");
    lines.push(
      `Verification: exhaustive enumeration of ${brute.explored} subsets confirms no subset satisfies all samples.`,
    );
    return lines.join("\n");
  }
  lines.push("Status: OPTIMAL");
  lines.push(`Total cost: ${bnb.cost}`);
  lines.push(
    `Selected rules (${bnb.selected.length}): ${bnb.selected
      .map((r) => `${r.id}(${r.action},cost=${r.cost})`)
      .join(", ") || "(none)"}`,
  );
  lines.push(`Subset mask: ${formatMask(bnb.mask, n)}`);
  lines.push("");
  lines.push("Evidence per sample:");
  for (const ev of buildEvidence(problem, bnb.selected)) {
    const mark = ev.ok ? "OK" : "FAIL";
    lines.push(
      `  [${mark}] sample ${ev.sampleId}: expect=${ev.expected} decision=${ev.decision}`,
    );
    if (ev.matched.length === 0) {
      lines.push("    matched rules: (none, default deny)");
    } else {
      for (const m of ev.matched) {
        lines.push(`    matched rule: ${m.id} (${m.action}, cost=${m.cost})`);
      }
    }
    if (ev.matched.some((m) => m.action === "deny")) {
      lines.push("    conflict resolution: deny wins");
    }
  }
  lines.push("");
  const agree =
    brute.feasible && brute.cost === bnb.cost && brute.mask === bnb.mask;
  lines.push(
    `Verification: exhaustive enumeration of ${brute.explored} subsets -> best cost ${brute.cost}, mask ${formatMask(brute.mask, n)}; branch-and-bound ${agree ? "AGREES" : "DISAGREES"}.`,
  );
  return lines.join("\n");
}

function renderJson(
  problem: Problem,
  bnb: SolveResult,
  brute: SolveResult,
): string {
  const payload = {
    status: bnb.feasible ? "optimal" : "infeasible",
    totalCost: bnb.feasible ? bnb.cost : null,
    selected: bnb.selected.map((r) => r.id),
    evidence: bnb.feasible ? buildEvidence(problem, bnb.selected) : null,
    verification: {
      method: "exhaustive-enumeration",
      subsetsExplored: brute.explored,
      bruteForce: {
        feasible: brute.feasible,
        cost: brute.feasible ? brute.cost : null,
        selected: brute.selected.map((r) => r.id),
      },
      agrees:
        brute.feasible === bnb.feasible &&
        (!bnb.feasible || (brute.cost === bnb.cost && brute.mask === bnb.mask)),
    },
  };
  return JSON.stringify(payload, null, 2);
}

export function run(argv: string[], io: CliIO = defaultIO): number {
  let args: CliArgs;
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
      io.stdout(usage());
      return 0;
    }
    args = parsed;
  } catch (err) {
    io.stderr(`Error: ${(err as Error).message}`);
    io.stderr(usage());
    return 2;
  }
  let problem: Problem;
  try {
    problem = parseProblem(JSON.parse(io.readInput(args.inputPath)));
  } catch (err) {
    io.stderr(`Error: ${(err as Error).message}`);
    return 2;
  }
  const bnb = solveBranchAndBound(problem);
  const brute = solveBruteForce(problem);
  io.stdout(args.json ? renderJson(problem, bnb, brute) : renderText(problem, bnb, brute));
  if (
    brute.feasible !== bnb.feasible ||
    (bnb.feasible && (brute.cost !== bnb.cost || brute.mask !== bnb.mask))
  ) {
    io.stderr("Error: branch-and-bound disagrees with exhaustive enumeration");
    return 3;
  }
  return bnb.feasible ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
