export interface Edge {
  id: string;
  from: string;
  to: string;
  cost: number;
  version: number;
}

export interface Graph {
  nodes: string[];
  edges: Edge[];
}

export function edgeById(graph: Graph): Map<string, Edge> {
  const map = new Map<string, Edge>();
  for (const edge of graph.edges) {
    if (map.has(edge.id)) {
      throw new Error(`duplicate edge id: ${edge.id}`);
    }
    map.set(edge.id, edge);
  }
  return map;
}
