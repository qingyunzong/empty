import type { Dag } from "./dag.js";
import type { Oracle } from "./oracle.js";
import { findBoundary } from "./bisect.js";
import type { BoundaryReport, NodeStatus, QueryRecord } from "./bisect.js";

export interface FullScan {
  status: Record<string, NodeStatus>;
  boundary: string[];
  evidence: QueryRecord[];
}

export async function scanFullDag(dag: Dag, oracle: Oracle): Promise<FullScan> {
  const report = await findBoundary(dag, oracle, Number.MAX_SAFE_INTEGER);
  return {
    status: report.status,
    boundary: report.confirmedBoundary,
    evidence: report.evidence,
  };
}

export type CrossCheckIssueKind =
  | "status-mismatch"
  | "false-positive"
  | "unexplained-miss";

export interface CrossCheckIssue {
  kind: CrossCheckIssueKind;
  version: string;
  detail: string;
}

export interface ExplainedMiss {
  version: string;
  reason: "untested" | "pending-self" | "parent-unresolved";
}

export interface CrossCheckReport {
  ok: boolean;
  issues: CrossCheckIssue[];
  confirmed: string[];
  explainedMisses: ExplainedMiss[];
}

export function crossCheck(
  dag: Dag,
  bounded: BoundaryReport,
  full: FullScan,
): CrossCheckReport {
  const issues: CrossCheckIssue[] = [];

  for (const [version, status] of Object.entries(bounded.status)) {
    const truth = full.status[version];
    if (truth !== undefined && truth !== status) {
      issues.push({
        kind: "status-mismatch",
        version,
        detail: `bounded run recorded "${status}" but full scan recorded "${truth}"`,
      });
    }
  }

  const fullBoundary = new Set(full.boundary);
  for (const version of bounded.confirmedBoundary) {
    if (!fullBoundary.has(version)) {
      issues.push({
        kind: "false-positive",
        version,
        detail: "reported as boundary bad under budget but not in full-DAG boundary",
      });
    }
  }

  const confirmed = bounded.confirmedBoundary.filter((version) => fullBoundary.has(version));
  const explainedMisses: ExplainedMiss[] = [];
  for (const version of full.boundary) {
    if (bounded.confirmedBoundary.includes(version)) continue;
    const boundedStatus = bounded.status[version];
    if (boundedStatus === undefined) {
      explainedMisses.push({ version, reason: "untested" });
      continue;
    }
    if (boundedStatus === "pending") {
      explainedMisses.push({ version, reason: "pending-self" });
      continue;
    }
    const parents = dag.parents.get(version) ?? [];
    const parentUnresolved = parents.some((parent) => {
      const parentStatus = bounded.status[parent];
      return parentStatus === undefined || parentStatus === "pending";
    });
    if (parentUnresolved) {
      explainedMisses.push({ version, reason: "parent-unresolved" });
      continue;
    }
    issues.push({
      kind: "unexplained-miss",
      version,
      detail: "in full-DAG boundary but neither confirmed nor explainable by budget/pending",
    });
  }

  return { ok: issues.length === 0, issues, confirmed, explainedMisses };
}
