export interface EdgeSpec {
  id: string;
  from: string;
  to: string;
  /** deletion cost, must be a non-negative finite number */
  cost: number;
  /** locked edges may never be deleted */
  locked?: boolean;
  /** package group this edge belongs to */
  group?: string;
}

export interface ReachReq {
  from: string;
  to: string;
}

export interface GroupSpec {
  /** deleting any edge of this group forces deletion of every edge in these groups */
  requires?: string[];
}

export interface Problem {
  nodes?: string[];
  edges: EdgeSpec[];
  /** maximum total deletion cost allowed (default: Infinity) */
  budget?: number;
  /** entry->exit reachability relations that must be preserved */
  reachability?: ReachReq[];
  groups?: Record<string, GroupSpec>;
}

export const MAX_EDGES = 18;

export interface NormalizedProblem {
  nodes: string[];
  edges: Required<EdgeSpec>[];
  budget: number;
  reachability: ReachReq[];
  /** group name -> edge indices */
  groupEdges: Map<string, number[]>;
  /** group name -> required group names */
  groupRequires: Map<string, string[]>;
}

export function normalize(raw: Problem): NormalizedProblem {
  if (!raw || !Array.isArray(raw.edges)) {
    throw new Error("problem must contain an 'edges' array");
  }
  if (raw.edges.length > MAX_EDGES) {
    throw new Error(`too many edges: ${raw.edges.length} > ${MAX_EDGES}`);
  }
  const seen = new Set<string>();
  const nodeSet = new Set<string>(raw.nodes ?? []);
  const edges = raw.edges.map((e, i) => {
    if (!e || typeof e.id !== "string" || typeof e.from !== "string" || typeof e.to !== "string") {
      throw new Error(`edge #${i} must have string id/from/to`);
    }
    if (seen.has(e.id)) throw new Error(`duplicate edge id: ${e.id}`);
    seen.add(e.id);
    if (typeof e.cost !== "number" || !Number.isFinite(e.cost) || e.cost < 0) {
      throw new Error(`edge ${e.id}: cost must be a non-negative finite number`);
    }
    nodeSet.add(e.from);
    nodeSet.add(e.to);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      cost: e.cost,
      locked: e.locked ?? false,
      group: e.group ?? "",
    };
  });
  const budget = raw.budget ?? Infinity;
  if (typeof budget !== "number" || budget < 0) {
    throw new Error("budget must be a non-negative number");
  }
  const groupEdges = new Map<string, number[]>();
  edges.forEach((e, i) => {
    if (!e.group) return;
    const list = groupEdges.get(e.group) ?? [];
    list.push(i);
    groupEdges.set(e.group, list);
  });
  const groupRequires = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(raw.groups ?? {})) {
    groupRequires.set(name, [...(spec.requires ?? [])]);
  }
  for (const [name, reqs] of groupRequires) {
    for (const r of reqs) {
      if (!groupEdges.has(r)) {
        throw new Error(`group ${name} requires unknown/empty group ${r}`);
      }
    }
  }
  const reachability = (raw.reachability ?? []).map((r) => {
    if (typeof r.from !== "string" || typeof r.to !== "string") {
      throw new Error("reachability entries need string from/to");
    }
    nodeSet.add(r.from);
    nodeSet.add(r.to);
    return { from: r.from, to: r.to };
  });
  return {
    nodes: [...nodeSet].sort(),
    edges,
    budget,
    reachability,
    groupEdges,
    groupRequires,
  };
}
