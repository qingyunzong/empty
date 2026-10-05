/** Raw input format (JSON file). */
export interface EdgeInput {
  id: string;
  from: string;
  to: string;
  /** deletion cost, non-negative integer, default 1 */
  cost?: number;
  /** locked edges can never be deleted, default false */
  locked?: boolean;
  /** optional package-group name */
  group?: string;
}

export interface GroupInput {
  /** if any edge of this group is deleted, ALL edges of each required group must be deleted too */
  requires?: string[];
}

export interface ProblemInput {
  nodes: string[];
  edges: EdgeInput[];
  /** every entry must reach every exit after repair */
  entries?: string[];
  exits?: string[];
  /** explicit extra reachability pairs that must be preserved */
  preserve?: Array<{ from: string; to: string }>;
  /** max total deletion cost, default Infinity */
  budget?: number;
  groups?: Record<string, GroupInput>;
}

/** Normalized internal edge. */
export interface Edge {
  id: string;
  from: string;
  to: string;
  cost: number;
  locked: boolean;
  group: string | null;
}

export interface Pair {
  from: string;
  to: string;
}

export interface Problem {
  nodes: string[];
  edges: Edge[];
  pairs: Pair[];
  budget: number;
  /** group -> groups it requires */
  groupRequires: Map<string, string[]>;
}

export const MAX_EDGES = 18;

export interface DeletedEdgeInfo {
  id: string;
  from: string;
  to: string;
  cost: number;
  group: string | null;
}

export interface PathCertificate {
  from: string;
  to: string;
  /** node sequence, edges all present in the remaining graph */
  path: string[];
}

export interface SolveStats {
  deletableEdges: number;
  nodesExplored: number;
  pruned: number;
}

export interface Solution {
  status: 'optimal' | 'infeasible';
  deletedEdges?: DeletedEdgeInfo[];
  totalCost?: number;
  topologicalOrder?: string[];
  preservedPaths?: PathCertificate[];
  proof?: {
    method: 'branch-and-bound';
    stats: SolveStats;
    /** present when cross-checked by exhaustive enumeration */
    enumeration?: {
      subsetsChecked: number;
      bestCost: number | null;
      matches: boolean;
    };
  };
  infeasible?: {
    reason: string;
    /** witness cycle (node list, last == first) when the locked subgraph is cyclic */
    cycle?: string[];
    /** cheapest feasible cost ignoring budget, when infeasible only due to budget */
    minCostWithoutBudget?: number;
  };
}
