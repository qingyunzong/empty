import type { SearchResult } from "./search.js";
import type { VerifyReport } from "./verify.js";
import type { Assignment, Spec, Value } from "./types.js";

export function formatAssignment(spec: Spec, assignment: Assignment): string {
  const parts: string[] = [];
  for (const attr of spec.attributes) {
    if (assignment.has(attr.name)) parts.push(`${attr.name}: ${JSON.stringify(assignment.get(attr.name))}`);
  }
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

export interface Report {
  verdict: SearchResult["verdict"];
  witness?: Record<string, Value>;
  specifiedFields?: number;
  decisions?: Record<string, string>;
  checked: number;
  space: string;
  budget: number;
  exhausted: boolean;
  crossCheck: VerifyReport;
}

export function buildReport(spec: Spec, result: SearchResult, verify: VerifyReport): Report {
  const report: Report = {
    verdict: result.verdict,
    checked: result.checked,
    space: result.space.toString(),
    budget: result.budget,
    exhausted: BigInt(result.checked) === result.space,
    crossCheck: verify,
  };
  if (result.verdict === "DIFFER") {
    const witness: Record<string, Value> = {};
    for (const attr of spec.attributes) {
      if (result.witness!.has(attr.name)) witness[attr.name] = result.witness!.get(attr.name)!;
    }
    report.witness = witness;
    report.specifiedFields = result.witness!.size;
    report.decisions = {
      [spec.policies[0].name]: result.decisions![0],
      [spec.policies[1].name]: result.decisions![1],
    };
  }
  return report;
}

export function formatText(spec: Spec, result: SearchResult, verify: VerifyReport): string {
  const lines: string[] = [];
  const [a, b] = spec.policies;
  if (result.verdict === "DIFFER") {
    lines.push("verdict: DIFFER");
    lines.push(`witness: ${formatAssignment(spec, result.witness!)}  (${result.witness!.size} specified field${result.witness!.size === 1 ? "" : "s"})`);
    lines.push(`  ${a.name}: ${result.decisions![0]}`);
    lines.push(`  ${b.name}: ${result.decisions![1]}`);
  } else if (result.verdict === "EQUIVALENT") {
    lines.push("verdict: EQUIVALENT (exhaustive: no attribute assignment makes the policies differ)");
  } else {
    lines.push("verdict: UNDECIDED (budget exhausted before the search space was fully enumerated)");
  }
  lines.push(`checked: ${result.checked} of ${result.space} partial assignments (budget ${result.budget})`);
  lines.push(`cross-check: ${verify.status}`);
  for (const check of verify.checks) lines.push(`  ok - ${check}`);
  for (const failure of verify.failures) lines.push(`  FAILED - ${failure}`);
  for (const note of verify.notes) lines.push(`  note - ${note}`);
  return lines.join("\n");
}
