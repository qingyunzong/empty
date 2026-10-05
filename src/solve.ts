import { solveBnB } from "./bnb.js";
import { solveBruteForce } from "./bruteForce.js";
import { buildEvidence, type Effect, type Problem, type SampleEvidence } from "./model.js";

export interface SelectedRule {
  id: string;
  cost: number;
  effect: Effect;
  matches: string[];
}

export interface BannedRule {
  id: string;
  reason: string;
}

export interface Verification {
  performed: boolean;
  subsetsEvaluated: number;
  agrees: boolean;
  detail: string;
}

export interface SolveReport {
  status: "optimal" | "infeasible";
  cost: number | null;
  subset: SelectedRule[];
  evidence: SampleEvidence[];
  banned: BannedRule[];
  verification: Verification;
  stats: { bnbNodes: number };
}

export interface SolveOptions {
  solver?: "bnb" | "brute"; // primary solver (default "bnb")
  verify?: boolean; // cross-check with the other solver (default true)
}

export function solve(problem: Problem, options: SolveOptions = {}): SolveReport {
  const solver = options.solver ?? "bnb";
  const verify = options.verify ?? true;

  const bnb = solveBnB(problem);
  const brute = solver === "brute" || verify ? solveBruteForce(problem) : null;
  const primary = solver === "brute" ? brute! : bnb;

  const banned: BannedRule[] = bnb.banned.map((i) => {
    const c = problem.candidates[i]!;
    const hit = problem.samples.filter((s) => s.expect === "allow" && c.matches.includes(s.id)).map((s) => s.id);
    return { id: c.id, reason: `deny rule matches allow-expected sample(s): ${hit.join(", ")}` };
  });

  let verification: Verification;
  if (verify && brute !== null) {
    const primaryIds = primary.indices.map((i) => problem.candidates[i]!.id).sort();
    const other = solver === "brute" ? bnb : brute;
    const otherIds = other.indices.map((i) => problem.candidates[i]!.id).sort();
    const otherName = solver === "brute" ? "branch-and-bound" : "brute force";
    const agrees =
      primary.feasible === other.feasible &&
      primary.cost === other.cost &&
      primaryIds.join("") === otherIds.join("");
    const detail = primary.feasible
      ? `${otherName} confirms optimum (cost ${String(primary.cost)}, subset [${primaryIds.join(", ")}])`
      : `${otherName} also found no feasible subset`;
    verification = { performed: true, subsetsEvaluated: brute.subsetsEvaluated, agrees, detail };
  } else {
    verification = { performed: false, subsetsEvaluated: 0, agrees: true, detail: "verification skipped" };
  }

  const subset: SelectedRule[] = primary.indices
    .map((i) => problem.candidates[i]!)
    .map((c) => ({ id: c.id, cost: c.cost, effect: c.effect, matches: c.matches }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    status: primary.feasible ? "optimal" : "infeasible",
    cost: primary.cost,
    subset,
    evidence: primary.feasible ? buildEvidence(problem, primary.indices) : [],
    banned,
    verification,
    stats: { bnbNodes: bnb.nodes },
  };
}
