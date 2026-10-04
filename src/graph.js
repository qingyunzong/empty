export function emptyGraph() {
  return { nodes: new Map(), edges: new Map(), deviceLoad: new Map() };
}

export function addNode(graph, node) {
  graph.nodes.set(node.id, {
    id: node.id,
    op: node.op,
    device: node.device,
    time: node.time,
  });
}

export function addEdge(graph, from, to) {
  if (!graph.edges.has(from)) graph.edges.set(from, new Set());
  graph.edges.get(from).add(to);
}

export function removeEdge(graph, from, to) {
  graph.edges.get(from)?.delete(to);
}

export function removeNode(graph, id) {
  graph.nodes.delete(id);
  graph.edges.delete(id);
  for (const outs of graph.edges.values()) outs.delete(id);
}

export function occupy(graph, device, minutes) {
  graph.deviceLoad.set(device, (graph.deviceLoad.get(device) ?? 0) + minutes);
}

export function applyChange(graph, change) {
  for (const [a, b] of change.removeEdges ?? []) removeEdge(graph, a, b);
  for (const id of change.removeNodes ?? []) removeNode(graph, id);
  for (const n of change.addNodes ?? []) addNode(graph, n);
  for (const [a, b] of change.addEdges ?? []) addEdge(graph, a, b);
  for (const [dev, minutes] of Object.entries(change.occupy ?? {})) {
    occupy(graph, dev, minutes);
  }
}

export function writeSetOf(change) {
  const ws = new Set();
  for (const n of change.addNodes ?? []) ws.add(n.id);
  for (const id of change.removeNodes ?? []) ws.add(id);
  for (const [a, b] of change.addEdges ?? []) {
    ws.add(a);
    ws.add(b);
  }
  for (const [a, b] of change.removeEdges ?? []) {
    ws.add(a);
    ws.add(b);
  }
  for (const dev of Object.keys(change.occupy ?? {})) ws.add(`device:${dev}`);
  return [...ws].sort();
}
