export class DagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
  }
}

export interface DagInput {
  nodes?: string[];
  edges: Array<[string, string]>;
}

export interface Dag {
  nodes: string[];
  parents: ReadonlyMap<string, readonly string[]>;
  children: ReadonlyMap<string, readonly string[]>;
  topoOrder: string[];
  roots: string[];
}

export function buildDag(input: DagInput): Dag {
  const declared = input.nodes ?? [];
  const nodeSet = new Set<string>(declared);
  if (nodeSet.size !== declared.length) {
    throw new DagError("duplicate node ids in input.nodes");
  }
  for (const [parent, child] of input.edges) {
    nodeSet.add(parent);
    nodeSet.add(child);
  }
  const nodes = input.nodes ? [...declared] : [...nodeSet];

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const id of nodes) {
    parents.set(id, []);
    children.set(id, []);
  }

  const seenEdges = new Set<string>();
  for (const [parent, child] of input.edges) {
    if (parent === child) {
      throw new DagError(`self-loop on version "${parent}"`);
    }
    const key = JSON.stringify([parent, child]);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    parents.get(child)!.push(parent);
    children.get(parent)!.push(child);
  }

  const indegree = new Map<string, number>();
  for (const id of nodes) indegree.set(id, parents.get(id)!.length);

  const queue: string[] = nodes.filter((id) => indegree.get(id) === 0);
  const topoOrder: string[] = [];
  const roots = [...queue];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    topoOrder.push(id);
    for (const child of children.get(id)!) {
      const next = indegree.get(child)! - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  if (topoOrder.length !== nodes.length) {
    const inOrder = new Set(topoOrder);
    const remaining = nodes.filter((id) => !inOrder.has(id));
    throw new DagError(`cycle detected involving versions: ${remaining.join(", ")}`);
  }

  return { nodes, parents, children, topoOrder, roots };
}
