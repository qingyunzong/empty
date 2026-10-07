export class Graph {
  constructor() {
    this.devices = new Map();
    this.nodes = new Map();
    this.adj = new Map();
  }

  addDevice(id, capacity) {
    this.devices.set(id, { id, capacity });
  }

  addNode(node) {
    this.nodes.set(node.id, {
      id: node.id,
      device: node.device ?? null,
      time: node.time ?? 0,
      load: node.load ?? 0,
    });
    if (!this.adj.has(node.id)) this.adj.set(node.id, []);
  }

  addEdge(from, to) {
    if (!this.adj.has(from)) this.adj.set(from, []);
    this.adj.get(from).push(to);
  }

  nodeIds() {
    return [...this.nodes.keys()].sort();
  }

  neighbors(id) {
    return (this.adj.get(id) ?? []).slice().sort();
  }

  hasCycle() {
    const indeg = new Map();
    for (const id of this.nodes.keys()) indeg.set(id, 0);
    for (const tos of this.adj.values()) {
      for (const to of tos) {
        if (indeg.has(to)) indeg.set(to, indeg.get(to) + 1);
      }
    }
    const queue = [...this.nodes.keys()].filter((id) => indeg.get(id) === 0);
    let seen = 0;
    while (queue.length) {
      const u = queue.shift();
      seen++;
      for (const v of this.adj.get(u) ?? []) {
        if (!indeg.has(v)) continue;
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) queue.push(v);
      }
    }
    return seen !== this.nodes.size;
  }

  toJSON() {
    const edges = [];
    for (const id of this.nodeIds()) {
      for (const to of this.neighbors(id)) edges.push({ from: id, to });
    }
    return {
      devices: [...this.devices.values()]
        .map((d) => ({ id: d.id, capacity: d.capacity }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      nodes: this.nodeIds().map((id) => this.nodes.get(id)),
      edges,
    };
  }

  static fromJSON(obj) {
    const g = new Graph();
    const devices = Array.isArray(obj.devices)
      ? obj.devices
      : Object.entries(obj.devices ?? {}).map(([id, d]) => ({ id, capacity: d.capacity ?? d }));
    for (const d of devices) g.addDevice(d.id, d.capacity);
    for (const n of obj.nodes ?? []) g.addNode(n);
    for (const e of obj.edges ?? []) g.addEdge(e.from, e.to);
    return g;
  }
}
