import { canonical, defSig, hashArtifact, hashFile, hashRelease, sha256 } from './hash.js';

export function findCycleNodes(artifacts) {
  const color = new Map();
  const stack = [];
  const inCycle = new Set();
  const dfs = (start) => {
    color.set(start, 1);
    stack.push(start);
    const frames = [[start, 0]];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const [node, idx] = frame;
      const inputs = (artifacts.get(node)?.inputs ?? []).filter((i) => artifacts.has(i));
      if (idx < inputs.length) {
        frame[1]++;
        const next = inputs[idx];
        const c = color.get(next) ?? 0;
        if (c === 0) {
          color.set(next, 1);
          stack.push(next);
          frames.push([next, 0]);
        } else if (c === 1) {
          const pos = stack.lastIndexOf(next);
          for (let k = pos; k < stack.length; k++) inCycle.add(stack[k]);
        }
      } else {
        color.set(node, 2);
        stack.pop();
        frames.pop();
      }
    }
  };
  for (const id of artifacts.keys()) if ((color.get(id) ?? 0) === 0) dfs(id);
  return inCycle;
}

export function topoLayers(artifacts, ids) {
  const set = new Set(ids);
  const indegree = new Map();
  const dependents = new Map();
  for (const id of set) {
    let deg = 0;
    for (const inp of artifacts.get(id).inputs) {
      if (set.has(inp)) {
        deg++;
        if (!dependents.has(inp)) dependents.set(inp, []);
        dependents.get(inp).push(id);
      }
    }
    indegree.set(id, deg);
  }
  let ready = [...set].filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  while (ready.length) {
    order.push(...ready);
    const next = [];
    for (const id of ready) {
      for (const dep of dependents.get(id) ?? []) {
        indegree.set(dep, indegree.get(dep) - 1);
        if (indegree.get(dep) === 0) next.push(dep);
      }
    }
    next.sort();
    ready = next;
  }
  return order;
}

function evaluateArtifact(id, artifact, builders, resolveInput) {
  if (!builders.has(artifact.builder)) {
    return { error: { code: 'E_BUILDER', message: `unknown builder '${artifact.builder}'` } };
  }
  const inputs = [];
  for (const inp of [...artifact.inputs].sort()) {
    const resolved = resolveInput(inp);
    if (resolved.error) return { error: resolved.error };
    inputs.push({ id: inp, hash: resolved.hash });
  }
  return { hash: hashArtifact(artifact.builder, inputs) };
}

export function fullBuild(state, builders) {
  const fileHash = new Map();
  for (const [id, f] of state.files) fileHash.set(id, hashFile(f.content));

  const cycleNodes = findCycleNodes(state.artifacts);
  const results = new Map();
  const errors = [];
  if (cycleNodes.size) {
    errors.push({ code: 'E_CYCLE', message: `dependency cycle among: ${[...cycleNodes].sort().join(', ')}`, nodes: [...cycleNodes].sort() });
  }
  for (const id of cycleNodes) {
    results.set(id, { error: { code: 'E_CYCLE', message: 'artifact is part of a dependency cycle' } });
  }

  const buildable = [...state.artifacts.keys()].filter((id) => !cycleNodes.has(id));
  const order = topoLayers(state.artifacts, buildable);
  if (order.length !== buildable.length) {
    errors.push({ code: 'E_CYCLE', message: 'unresolved cyclic dependencies remain', nodes: buildable.filter((id) => !order.includes(id)).sort() });
  }

  const resolveInput = (inp) => {
    if (fileHash.has(inp)) return { hash: fileHash.get(inp) };
    if (state.artifacts.has(inp)) {
      const r = results.get(inp);
      if (r?.error) return { error: { code: 'E_INPUT_FAILED', message: `input '${inp}' failed (${r.error.code})` } };
      if (r?.hash) return { hash: r.hash };
      return { error: { code: 'E_INPUT_FAILED', message: `input '${inp}' unavailable` } };
    }
    return { error: { code: 'E_INPUT', message: `input '${inp}' does not exist` } };
  };

  for (const id of order) {
    const r = evaluateArtifact(id, state.artifacts.get(id), builders, resolveInput);
    results.set(id, r);
    if (r.error) errors.push({ code: r.error.code, message: `artifact '${id}': ${r.error.message}`, nodes: [id] });
  }

  const releases = new Map();
  for (const [id, rel] of state.releases) {
    const inputs = [];
    const blockedBy = [];
    for (const inp of [...rel.inputs].sort()) {
      if (fileHash.has(inp)) {
        inputs.push({ id: inp, hash: fileHash.get(inp) });
      } else if (state.artifacts.has(inp)) {
        const r = results.get(inp);
        if (r?.hash) inputs.push({ id: inp, hash: r.hash });
        else blockedBy.push(inp);
      } else {
        blockedBy.push(inp);
      }
    }
    if (blockedBy.length) {
      releases.set(id, { status: 'blocked', blockedBy: blockedBy.sort() });
    } else {
      releases.set(id, { status: 'ok', hash: hashRelease(inputs) });
    }
  }

  return { fileHash, artifacts: results, releases, errors };
}

export function certificateOf(state, build, tx) {
  const files = {};
  for (const [id, h] of [...build.fileHash.entries()].sort()) files[id] = h;
  const artifacts = {};
  for (const [id, r] of [...build.artifacts.entries()].sort()) {
    artifacts[id] = r.hash ?? { error: r.error.code };
  }
  const releases = {};
  for (const [id, r] of [...build.releases.entries()].sort()) {
    releases[id] = r.status === 'ok' ? { status: 'ok', hash: r.hash } : { status: 'blocked', blockedBy: r.blockedBy };
  }
  const graphHash = sha256(canonical({ files, artifacts, releases }));
  return { version: 1, tx: tx ?? null, graphHash, files, artifacts, releases };
}

export function hashesOf(build) {
  const out = {};
  for (const [id, h] of build.fileHash) out[id] = h;
  for (const [id, r] of build.artifacts) if (r.hash) out[id] = r.hash;
  for (const [id, r] of build.releases) if (r.status === 'ok') out[id] = r.hash;
  return out;
}

export function failedOf(build) {
  const out = {};
  for (const [id, r] of build.artifacts) if (r.error) out[id] = r.error.code;
  return out;
}

export function blockedOf(build) {
  const out = {};
  for (const [id, r] of build.releases) if (r.status === 'blocked') out[id] = r.blockedBy;
  return out;
}
