'use strict';

// Independent reference: replays the journal into plain maps, then answers
// every question by brute-force DFS (upward for ancestors, downward for paths).
// Used to cross-check the incremental Genealogy implementation.

function buildReference(journal) {
  const batches = new Map(); // id -> { held, shipped }
  const parents = new Map(); // output -> [inputs]
  for (const event of journal) {
    switch (event.op) {
      case 'define':
        batches.set(event.batch, { held: false, shipped: false });
        break;
      case 'transform':
        parents.set(event.output, event.inputs.slice());
        break;
      case 'hold':
        batches.get(event.batch).held = true;
        break;
      case 'release':
        batches.get(event.batch).held = false;
        break;
      case 'ship':
        batches.get(event.batch).shipped = true;
        break;
      default:
        throw new Error(`reference: unexpected op ${event.op}`);
    }
  }
  const children = new Map();
  for (const id of batches.keys()) children.set(id, []);
  for (const [output, inputs] of parents) {
    for (const input of inputs) children.get(input).push(output);
  }

  function heldAncestorsOf(target) {
    const found = new Set();
    const seen = new Set([target]);
    const stack = [target];
    while (stack.length > 0) {
      const node = stack.pop();
      if (batches.get(node).held) found.add(node);
      for (const parent of parents.get(node) || []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    return found;
  }

  function statusOf(target) {
    if (batches.get(target).shipped) return 'shipped';
    return heldAncestorsOf(target).size > 0 ? 'held' : 'released';
  }

  function pathsBetween(source, target) {
    const paths = [];
    const walk = (node, trail) => {
      if (node === target) {
        paths.push(trail.slice());
        return;
      }
      for (const child of children.get(node)) {
        trail.push(child);
        walk(child, trail);
        trail.pop();
      }
    };
    walk(source, [source]);
    return paths;
  }

  return { batches, parents, heldAncestorsOf, statusOf, pathsBetween };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { buildReference, mulberry32 };
