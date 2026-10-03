import { tokenize, normalizeTerm } from './tokenize.js';

// Positional inverted index over node `reason` fields.
// postings: term -> Map(nodeId -> sorted position array)
export class PositionalIndex {
  constructor() {
    this.postings = new Map();
  }

  static fromNodes(nodes) {
    const index = new PositionalIndex();
    for (const node of nodes) index.add(node.id, node.reason ?? '');
    return index;
  }

  add(nodeId, reason) {
    const tokens = tokenize(reason);
    for (let position = 0; position < tokens.length; position++) {
      const term = tokens[position];
      let byNode = this.postings.get(term);
      if (!byNode) {
        byNode = new Map();
        this.postings.set(term, byNode);
      }
      let list = byNode.get(nodeId);
      if (!list) {
        list = [];
        byNode.set(nodeId, list);
      }
      list.push(position);
    }
  }

  // Ordered near query: occurrences of `first` followed by `second` with at
  // most `slop` tokens in between (i.e. pos2 - pos1 - 1 <= slop, pos2 > pos1).
  // Returns Map(nodeId -> Array<[pos1, pos2]>) with pairs sorted ascending.
  near(first, second, slop) {
    if (!Number.isInteger(slop) || slop < 0) {
      throw new Error(`slop must be a non-negative integer, got: ${slop}`);
    }
    const termA = normalizeTerm(first);
    const termB = normalizeTerm(second);
    const result = new Map();
    const postingsA = this.postings.get(termA);
    const postingsB = this.postings.get(termB);
    if (!postingsA || !postingsB) return result;
    for (const [nodeId, positionsA] of postingsA) {
      const positionsB = postingsB.get(nodeId);
      if (!positionsB) continue;
      const pairs = [];
      let cursor = 0;
      for (const posA of positionsA) {
        while (cursor < positionsB.length && positionsB[cursor] <= posA) cursor++;
        for (let k = cursor; k < positionsB.length; k++) {
          const posB = positionsB[k];
          if (posB - posA - 1 > slop) break;
          pairs.push([posA, posB]);
        }
      }
      if (pairs.length > 0) result.set(nodeId, pairs);
    }
    return result;
  }
}
