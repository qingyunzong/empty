export class Graph {
  constructor() {
    this.adj = new Map();
  }

  addNode(node) {
    if (!this.adj.has(node)) this.adj.set(node, new Set());
  }

  addEdge(from, to) {
    this.addNode(from);
    this.addNode(to);
    this.adj.get(from).add(to);
  }

  deleteEdge(from, to) {
    const targets = this.adj.get(from);
    if (targets) targets.delete(to);
  }

  toState() {
    const nodes = [...this.adj.keys()].sort();
    const edges = [];
    for (const from of nodes) {
      for (const to of [...this.adj.get(from)].sort()) edges.push([from, to]);
    }
    return { nodes, edges };
  }

  static fromState(state) {
    const graph = new Graph();
    for (const node of state.nodes) graph.addNode(node);
    for (const [from, to] of state.edges) graph.addEdge(from, to);
    return graph;
  }

  scc() {
    const index = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const components = [];
    let counter = 0;

    const strongconnect = (start) => {
      const work = [[start, [...this.adj.get(start)].sort()[Symbol.iterator]()]];
      index.set(start, counter);
      lowlink.set(start, counter);
      counter += 1;
      stack.push(start);
      onStack.add(start);

      while (work.length > 0) {
        const frame = work[work.length - 1];
        const node = frame[0];
        const it = frame[1];
        const next = it.next();
        if (next.done) {
          work.pop();
          if (lowlink.get(node) === index.get(node)) {
            const component = [];
            let member;
            do {
              member = stack.pop();
              onStack.delete(member);
              component.push(member);
            } while (member !== node);
            components.push(component.sort());
          }
          if (work.length > 0) {
            const parent = work[work.length - 1][0];
            lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
          }
          continue;
        }
        const target = next.value;
        if (!index.has(target)) {
          index.set(target, counter);
          lowlink.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push([target, [...this.adj.get(target)].sort()[Symbol.iterator]()]);
        } else if (onStack.has(target)) {
          lowlink.set(node, Math.min(lowlink.get(node), index.get(target)));
        }
      }
    };

    for (const node of [...this.adj.keys()].sort()) {
      if (!index.has(node)) strongconnect(node);
    }

    components.sort((a, b) => {
      const byFirst = a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      return byFirst !== 0 ? byFirst : a.length - b.length;
    });
    return components;
  }
}
