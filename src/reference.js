// Reference evaluator: deliberately independent, brute-force.
// For every result node it enumerates ALL substitute paths (declared batch plus
// every substitute edge) and checks each candidate batch directly. Validity of
// derived/chart/conclusion nodes is then propagated by fixpoint iteration.

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function batchOk(batch, now) {
  if (batch.status !== 'active') return false;
  if (batch.corrected) return false;
  if (batch.expiresAt && now && now >= batch.expiresAt) return false;
  return true;
}

function checkRefs(state) {
  const ids = [...state.nodes.keys()].sort(cmp);
  for (const id of ids) {
    const node = state.nodes.get(id);
    if (node.kind === 'result') {
      for (const ref of [node.batchId, ...node.substitutes]) {
        if (!state.batches.has(ref)) return { code: 'E_REF', node: id, ref };
      }
    }
    for (const dep of node.dependsOn ?? []) {
      if (!state.nodes.has(dep)) return { code: 'E_REF', node: id, ref: dep };
    }
  }
  return null;
}

function checkCycle(state) {
  const color = new Map();
  const stack = [];
  function dfs(id) {
    color.set(id, 1);
    stack.push(id);
    for (const dep of [...(state.nodes.get(id).dependsOn ?? [])].sort(cmp)) {
      const c = color.get(dep) ?? 0;
      if (c === 0) {
        const r = dfs(dep);
        if (r) return r;
      } else if (c === 1) {
        return stack.slice(stack.indexOf(dep)).concat(dep);
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  }
  for (const id of [...state.nodes.keys()].sort(cmp)) {
    if ((color.get(id) ?? 0) === 0) {
      const r = dfs(id);
      if (r) return r;
    }
  }
  return null;
}

export function referenceEvaluate(state) {
  const refError = checkRefs(state);
  if (refError) return { error: refError, status: null, nodes: {} };
  const cycle = checkCycle(state);
  if (cycle) return { error: { code: 'E_CYCLE', cycle }, status: null, nodes: {} };

  const ids = [...state.nodes.keys()].sort(cmp);
  const valid = new Map();
  const chosen = new Map();

  // Enumerate every substitute path for each result node.
  for (const id of ids) {
    const node = state.nodes.get(id);
    if (node.kind !== 'result') {
      valid.set(id, false);
      chosen.set(id, null);
      continue;
    }
    const candidates = [...new Set([node.batchId, ...node.substitutes])];
    const good = candidates.filter((c) => batchOk(state.batches.get(c), state.now)).sort(cmp);
    valid.set(id, Boolean(node.protocolVersion) && good.length > 0);
    chosen.set(id, node.protocolVersion && good.length > 0 ? good[0] : null);
  }

  // Fixpoint propagation along derived/chart/conclusion nodes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      const node = state.nodes.get(id);
      if (node.kind === 'result') continue;
      const ok = (node.dependsOn ?? []).every((d) => valid.get(d));
      if (ok !== valid.get(id)) {
        valid.set(id, ok);
        changed = true;
      }
    }
  }

  // Deterministic invalidation paths: recurse through the smallest invalid dependency.
  const pathMemo = new Map();
  function pathOf(id) {
    if (valid.get(id)) return null;
    if (pathMemo.has(id)) return pathMemo.get(id);
    const node = state.nodes.get(id);
    let path;
    if (node.kind === 'result') {
      path = [id];
    } else {
      const bad = (node.dependsOn ?? []).filter((d) => !valid.get(d)).sort(cmp);
      path = [...pathOf(bad[0]), id];
    }
    pathMemo.set(id, path);
    return path;
  }

  const nodes = {};
  let allValid = true;
  for (const id of ids) {
    if (!valid.get(id)) allValid = false;
    nodes[id] = {
      status: valid.get(id) ? 'valid' : 'invalid',
      chosenBatch: chosen.get(id),
      invalidationPath: pathOf(id),
    };
  }
  return { error: null, status: allValid ? 'valid' : 'invalid', nodes };
}
