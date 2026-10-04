import type { Dag } from "./dag.js";
import type { Oracle } from "./oracle.js";

export type NodeStatus = "good" | "bad" | "pending";

export interface QueryRecord {
  seq: number;
  version: string;
  outcome: "good" | "bad" | "error";
  error?: string;
}

export interface BoundaryReport {
  budget: number;
  queriesUsed: number;
  status: Record<string, NodeStatus>;
  confirmedBoundary: string[];
  unresolvedBoundary: string[];
  untested: string[];
  evidence: QueryRecord[];
  complete: boolean;
}

export async function findBoundary(
  dag: Dag,
  oracle: Oracle,
  budget: number,
): Promise<BoundaryReport> {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new RangeError(`budget must be a non-negative integer, got ${budget}`);
  }

  const status = new Map<string, NodeStatus>();
  const evidence: QueryRecord[] = [];
  let queriesUsed = 0;

  for (const version of dag.topoOrder) {
    if (queriesUsed >= budget) break;
    queriesUsed += 1;
    const seq = evidence.length + 1;
    try {
      const verdict = await oracle.test(version);
      status.set(version, verdict);
      evidence.push({ seq, version, outcome: verdict });
    } catch (err) {
      status.set(version, "pending");
      const message = err instanceof Error ? err.message : String(err);
      evidence.push({ seq, version, outcome: "error", error: message });
    }
  }

  const confirmedBoundary: string[] = [];
  const unresolvedBoundary: string[] = [];
  for (const version of dag.topoOrder) {
    if (status.get(version) !== "bad") continue;
    const parents = dag.parents.get(version) ?? [];
    let allGood = true;
    for (const parent of parents) {
      if (status.get(parent) !== "good") {
        allGood = false;
        break;
      }
    }
    if (allGood) {
      confirmedBoundary.push(version);
    } else {
      const explainable = parents.some((parent) => {
        const parentStatus = status.get(parent);
        return parentStatus === undefined || parentStatus === "pending";
      });
      if (explainable) unresolvedBoundary.push(version);
    }
  }

  const untested = dag.topoOrder.filter((version) => !status.has(version));
  const hasPending = [...status.values()].some((value) => value === "pending");

  return {
    budget,
    queriesUsed,
    status: Object.fromEntries(status),
    confirmedBoundary,
    unresolvedBoundary,
    untested,
    evidence,
    complete: untested.length === 0 && !hasPending,
  };
}
