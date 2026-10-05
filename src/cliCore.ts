import { MAX_CANDIDATES, validateProblem } from "./model.js";
import { solve, type SolveReport } from "./solve.js";

export const USAGE = `perm-mincover - minimum-cost permission-rule subset selection

Usage:
  node dist/src/cli.js [input.json] [options]
  cat input.json | node dist/src/cli.js [options]

Input (JSON):
  {
    "candidates": [                       // at most ${MAX_CANDIDATES}
      { "id": "r1", "cost": 2, "effect": "allow", "matches": ["s1"] }
    ],
    "samples": [
      { "id": "s1", "expect": "allow" }   // or "deny"
    ]
  }

Semantics (deny priority):
  A sample is "deny" if any selected matching rule denies it, else "allow"
  if any selected matching rule allows it, else default "deny".
  The goal is the minimum-cost subset of candidates whose decisions match
  every sample's expectation.

Options:
  --solver bnb|brute   Primary solver (default: bnb; both are exact).
  --no-verify          Skip the brute-force cross-check (on by default).
  --json               Print the full report as JSON.
  -h, --help           Show this help.

Exit codes: 0 = optimal subset found, 1 = infeasible, 2 = invalid input/usage.
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function formatReport(report: SolveReport): string {
  const out: string[] = [];
  if (report.status === "optimal") {
    out.push("Status: OPTIMAL");
    out.push(`Total cost: ${String(report.cost)}`);
    out.push(`Selected rules (${report.subset.length}): ${report.subset.map((r) => r.id).join(", ")}`);
  } else {
    out.push("Status: INFEASIBLE");
    out.push("No subset of the candidates satisfies all samples.");
  }
  if (report.banned.length > 0) {
    out.push("Never selectable (would violate an allow-expected sample):");
    for (const b of report.banned) out.push(`  ${b.id}: ${b.reason}`);
  }
  if (report.evidence.length > 0) {
    out.push("Evidence per sample:");
    for (const e of report.evidence) {
      out.push(`  ${e.sampleId}: expected=${e.expected}, actual=${e.actual} - ${e.reason}`);
    }
  }
  if (report.verification.performed) {
    const mark = report.verification.agrees ? "OK" : "MISMATCH";
    out.push(
      `Verification: brute force enumerated ${report.verification.subsetsEvaluated} subsets; ` +
        `${report.verification.detail}. ${mark}`,
    );
  }
  out.push(`(branch-and-bound explored ${report.stats.bnbNodes} nodes)`);
  return out.join("\n") + "\n";
}

// Pure CLI core: all input arrives via readInput (file path, "-" or null for
// stdin), all output is returned. This keeps the whole CLI testable without
// spawning child processes.
export function runCli(argv: string[], readInput: (file: string | null) => string): CliResult {
  let file: string | null = null;
  let json = false;
  let verify = true;
  let solver: "bnb" | "brute" = "bnb";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--no-verify") {
      verify = false;
    } else if (arg === "--solver") {
      const value = argv[++i];
      if (value === "bnb" || value === "brute") solver = value;
      else return { code: 2, stdout: "", stderr: `error: --solver expects "bnb" or "brute", got "${String(value)}"\n` };
    } else if (arg === "--help" || arg === "-h") {
      return { code: 0, stdout: USAGE, stderr: "" };
    } else if (arg.startsWith("--")) {
      return { code: 2, stdout: "", stderr: `error: unknown option "${arg}"\n` };
    } else if (file === null) {
      file = arg;
    } else {
      return { code: 2, stdout: "", stderr: `error: unexpected extra argument "${arg}"\n` };
    }
  }

  let text: string;
  try {
    text = readInput(file);
  } catch {
    return { code: 2, stdout: "", stderr: `error: could not read ${file === null ? "stdin" : `file "${file}"`}\n` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { code: 2, stdout: "", stderr: "error: input is not valid JSON\n" };
  }
  const { problem, errors } = validateProblem(raw);
  if (problem === null) {
    return { code: 2, stdout: "", stderr: errors.map((e) => `error: ${e}\n`).join("") };
  }

  const report = solve(problem, { solver, verify });
  const stdout = json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report);
  if (!report.verification.agrees) {
    return {
      code: 2,
      stdout,
      stderr: "error: internal solver disagreement between primary and verification solver\n",
    };
  }
  return { code: report.status === "optimal" ? 0 : 1, stdout, stderr: "" };
}
