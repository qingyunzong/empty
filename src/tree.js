import { UndoError, ERR } from './errors.js';

// In-memory view of the transaction forest: node map + children adjacency.
export class Forest {
  constructor(nodes) {
    this.nodes = new Map();
    this.children = new Map();
    for (const node of nodes) {
      if (this.nodes.has(node.id)) {
        throw new UndoError(ERR.DUPLICATE_NODE, `duplicate node id: ${node.id}`, { id: node.id });
      }
      this.nodes.set(node.id, { ...node });
    }
    for (const node of this.nodes.values()) {
      if (node.parentId != null) {
        let list = this.children.get(node.parentId);
        if (!list) {
          list = [];
          this.children.set(node.parentId, list);
        }
        list.push(node.id);
      }
    }
    for (const list of this.children.values()) list.sort();
  }

  // Walks the parent chain from `startId`; throws CYCLE_DETECTED on a repeat.
  // A parentId pointing at a missing node ends the chain (dangling ref).
  assertAcyclicChain(startId) {
    const seen = new Set();
    let current = startId;
    while (current != null) {
      if (seen.has(current)) {
        throw new UndoError(ERR.CYCLE_DETECTED, `parent chain cycle at node: ${current}`, { id: current });
      }
      seen.add(current);
      const node = this.nodes.get(current);
      if (!node) break;
      current = node.parentId;
    }
  }

  // BFS over children adjacency; visited set guards against adjacency loops.
  collectSubtree(rootId) {
    const order = [];
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift();
      order.push(id);
      for (const child of this.children.get(id) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return order;
  }

  // Depth of every node reachable from rootId, root itself at level 0.
  levelsFrom(rootId) {
    const levels = new Map([[rootId, 0]]);
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift();
      for (const child of this.children.get(id) ?? []) {
        if (!levels.has(child)) {
          levels.set(child, levels.get(id) + 1);
          queue.push(child);
        }
      }
    }
    return levels;
  }
}
