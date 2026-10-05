import type { NodeId } from "./types";

export interface GraphEdge {
  to: NodeId;
  cost: number;
}

export interface Graph {
  ids: NodeId[];
  adj: Map<NodeId, GraphEdge[]>;
  start: NodeId;
  end: NodeId;
  checkpoints: Set<NodeId>;
  maxNodes: number;
}

export const DEFAULT_MAX_NODES = 12;

function asId(value: unknown, what: string): NodeId {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`${what} must be a non-empty string or a finite number`);
}

export function buildGraph(input: unknown): Graph {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("input must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  if (!Array.isArray(raw.edges)) throw new Error('"edges" must be an array');
  const start = asId(raw.start, '"start"');
  const end = asId(raw.end, '"end"');

  let maxNodes = DEFAULT_MAX_NODES;
  if (raw.maxNodes !== undefined) {
    if (typeof raw.maxNodes !== "number" || !Number.isInteger(raw.maxNodes) || raw.maxNodes < 1) {
      throw new Error('"maxNodes" must be a positive integer');
    }
    maxNodes = raw.maxNodes;
  }

  const directed = raw.directed === true;

  const ids: NodeId[] = [];
  const seen = new Set<NodeId>();
  const addId = (id: NodeId): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  const declared = new Set<NodeId>();
  if (raw.nodes !== undefined) {
    if (!Array.isArray(raw.nodes)) throw new Error('"nodes" must be an array');
    for (const n of raw.nodes) {
      const id = asId(n, "node id");
      declared.add(id);
      addId(id);
    }
  }

  const edges: Array<{ from: NodeId; to: NodeId; cost: number }> = [];
  raw.edges.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`edges[${i}] must be an object`);
    }
    const eo = entry as Record<string, unknown>;
    const from = asId(eo.from, `edges[${i}].from`);
    const to = asId(eo.to, `edges[${i}].to`);
    const cost = eo.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost)) {
      throw new Error(`edges[${i}].cost must be a finite number`);
    }
    edges.push({ from, to, cost });
    addId(from);
    addId(to);
  });

  addId(start);
  addId(end);

  const checkpoints = new Set<NodeId>();
  if (raw.checkpoints !== undefined) {
    if (!Array.isArray(raw.checkpoints)) throw new Error('"checkpoints" must be an array');
    for (const c of raw.checkpoints) checkpoints.add(asId(c, "checkpoint"));
  }

  if (raw.nodes !== undefined) {
    const refs: NodeId[] = [start, end, ...checkpoints];
    for (const e of edges) refs.push(e.from, e.to);
    for (const ref of refs) {
      if (!declared.has(ref)) {
        throw new Error(`unknown node "${ref}" (not listed in "nodes")`);
      }
    }
  }

  const adj = new Map<NodeId, GraphEdge[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.from)!.push({ to: e.to, cost: e.cost });
    if (!directed) adj.get(e.to)!.push({ to: e.from, cost: e.cost });
  }

  return { ids, adj, start, end, checkpoints, maxNodes };
}
