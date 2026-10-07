export interface Edge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  /** Bumped by the graph owner whenever the edge changes; certificates pin a version. */
  readonly version: number;
}

export class Graph {
  private readonly edgesById = new Map<string, Edge>();
  private readonly outgoingByNode = new Map<string, Edge[]>();
  private readonly nodeSet = new Set<string>();

  constructor(edges: readonly Edge[] = []) {
    for (const edge of edges) this.addEdge(edge);
  }

  addEdge(edge: Edge): void {
    if (this.edgesById.has(edge.id)) {
      throw new Error(`duplicate edge id: ${edge.id}`);
    }
    this.edgesById.set(edge.id, edge);
    this.nodeSet.add(edge.from);
    this.nodeSet.add(edge.to);
    let list = this.outgoingByNode.get(edge.from);
    if (list === undefined) {
      list = [];
      this.outgoingByNode.set(edge.from, list);
    }
    list.push(edge);
  }

  addNode(node: string): void {
    this.nodeSet.add(node);
  }

  getEdge(id: string): Edge | undefined {
    return this.edgesById.get(id);
  }

  outgoing(node: string): readonly Edge[] {
    return this.outgoingByNode.get(node) ?? [];
  }

  nodes(): readonly string[] {
    return [...this.nodeSet];
  }

  edges(): readonly Edge[] {
    return [...this.edgesById.values()];
  }
}
