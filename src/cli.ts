import { readFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseProblem, solve } from "./solver.js";
import { verify } from "./verifier.js";
import { bruteForce, BRUTE_FORCE_MAX_N } from "./bruteforce.js";
import type { Problem, SolveResult } from "./types.js";

const USAGE = `Usage: npm start -- <input.json | -> [options]

Assign up to 12 work orders one-to-one to the same number of workstations
at minimum total cost. Forbidden pairs are rejected; costs may be negative.

Input JSON:
  {
    "orders":   ["W1", "W2", ...],           // 1..12 unique IDs
    "stations": ["S1", "S2", ...],           // same count, unique IDs
    "costs":    [[c, null, ...], ...]        // n x n; null or "x" = forbidden
  }

Options:
  --brute   cross-check against full permutation enumeration (n <= ${BRUTE_FORCE_MAX_N})
  --json    print machine-readable JSON only
  --help    show this help

Exit codes: 0 = optimal found, 2 = infeasible (Hall witness printed), 1 = error.`;

// Synchronous writes: safe with process.exit and piped stdio.
const out = (s: string): void => {
  writeSync(1, s + "\n");
};
const err = (s: string): void => {
  writeSync(2, s + "\n");
};

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function toJson(problem: Problem, result: SolveResult): unknown {
  if (result.status === "optimal") {
    return {
      status: "optimal",
      cost: result.cost,
      assignment: result.matching.map((j, i) => ({
        order: problem.orders[i],
        station: problem.stations[j],
        cost: problem.costs[i]![j],
      })),
      dual: { u: result.dual.u, v: result.dual.v },
    };
  }
  return {
    status: "infeasible",
    hallWitness: {
      orders: result.hall.rows.map((i) => problem.orders[i]),
      neighborStations: result.hall.neighbors.map((j) => problem.stations[j]),
    },
  };
}

function toText(problem: Problem, result: SolveResult): string {
  const lines: string[] = [];
  if (result.status === "optimal") {
    lines.push("status: optimal");
    lines.push(`cost: ${fmt(result.cost)}`);
    lines.push("assignment:");
    result.matching.forEach((j, i) => {
      lines.push(`  ${problem.orders[i]} -> ${problem.stations[j]} (cost ${fmt(problem.costs[i]![j]!)})`);
    });
    lines.push("dual certificate:");
    lines.push(`  u = [${result.dual.u.map(fmt).join(", ")}]`);
    lines.push(`  v = [${result.dual.v.map(fmt).join(", ")}]`);
  } else {
    lines.push("status: infeasible");
    const s = result.hall.rows.map((i) => problem.orders[i]).join(", ");
    const t = result.hall.neighbors.map((j) => problem.stations[j]).join(", ");
    lines.push(`hall witness: orders {${s}} connect only to stations {${t}}`);
    lines.push(`  |N(S)| = ${result.hall.neighbors.length} < |S| = ${result.hall.rows.length}`);
  }
  return lines.join("\n");
}

function main(): number {
  let args;
  try {
    args = parseArgs({
      options: {
        brute: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    err((e as Error).message);
    err(USAGE);
    return 1;
  }
  if (args.values.help || args.positionals.length !== 1) {
    out(USAGE);
    return args.values.help ? 0 : 1;
  }
  const source = args.positionals[0]!;
  let raw: string;
  try {
    raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  } catch (e) {
    err(`cannot read input: ${(e as Error).message}`);
    return 1;
  }
  let problem: Problem;
  try {
    problem = parseProblem(JSON.parse(raw));
  } catch (e) {
    err(`invalid input: ${(e as Error).message}`);
    return 1;
  }

  const result = solve(problem);
  const check = verify(problem, result);
  if (!check.ok) {
    err("INTERNAL ERROR: certificate verification failed:");
    for (const e of check.errors) err(`  - ${e}`);
    return 1;
  }

  let bruteNote = "";
  if (args.values.brute) {
    if (problem.orders.length > BRUTE_FORCE_MAX_N) {
      bruteNote = `brute force: skipped (n > ${BRUTE_FORCE_MAX_N})`;
    } else {
      const bf = bruteForce(problem);
      const agree =
        result.status === "optimal"
          ? bf.feasible && Math.abs(bf.cost - result.cost) < 1e-9
          : !bf.feasible;
      if (!agree) {
        err(`INTERNAL ERROR: brute force disagrees (solver=${JSON.stringify(toJson(problem, result))}, brute=${JSON.stringify(bf)})`);
        return 1;
      }
      bruteNote = `brute force: agrees (${bf.permutationsExamined} permutations examined)`;
    }
  }

  if (args.values.json) {
    out(JSON.stringify({ result: toJson(problem, result), verification: "ok" }, null, 2));
  } else {
    out(toText(problem, result));
    out("verification: ok");
    if (bruteNote) out(bruteNote);
  }
  return result.status === "optimal" ? 0 : 2;
}

process.exit(main());
