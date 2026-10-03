// Shared test helpers: tmp dirs, seeded PRNG, random DAG scenarios, and an
// independent reference evaluator (fixpoint closure enumeration) used to
// cross-check the library's memoized recursive evaluator.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference evaluator: fixpoint enumeration over the node set.
// Deliberately implemented differently from src/graph.js (iterative closure
// instead of memoized recursion) so the comparison is meaningful.
export function referenceEvaluateAll(state) {
  const status = {};
  const support = {};
  for (const [id, f] of Object.entries(state.facts)) {
    status[id] = f.deleted
      ? 'deleted'
      : state.sources[f.source]?.revoked
        ? 'revoked'
        : 'valid';
    support[id] = f.value ?? 1;
  }
  const pending = new Set(Object.keys(state.derived));
  let progress = true;
  while (progress) {
    progress = false;
    for (const id of [...pending]) {
      const d = state.derived[id];
      const resolvable = d.inputs.every(
        (i) => (!(i in state.facts) && !(i in state.derived)) || status[i] !== undefined,
      );
      if (!resolvable) continue;
      const childStates = d.inputs.map((i) => status[i] ?? 'unknown');
      if (childStates.includes('unknown')) {
        status[id] = 'unknown';
      } else {
        const validInputs = d.inputs.filter((i) => status[i] === 'valid');
        const sup =
          d.op === 'count'
            ? validInputs.length
            : validInputs.reduce((acc, i) => acc + support[i], 0);
        support[id] = sup;
        status[id] =
          childStates.every((s) => s === 'valid') && sup >= d.min ? 'valid' : 'degraded';
      }
      pending.delete(id);
      progress = true;
    }
  }
  if (pending.size > 0) throw new Error(`reference: unresolved nodes (cycle?): ${[...pending]}`);
  return status;
}

// Build a random acyclic scenario (<= maxNodes nodes) as a list of
// [type, payload] command pairs. Derived inputs only reference earlier
// nodes, so no cycles can occur. Revokes only target sources that own facts.
export function randomScenario(rand, maxNodes = 100) {
  const commands = [];
  const nodeIds = [];
  const nSources = 2 + Math.floor(rand() * 6);
  const sourceIds = [];
  for (let i = 0; i < nSources; i += 1) sourceIds.push(`s${i}`);
  const nFacts = 10 + Math.floor(rand() * 30);
  const nDerived = maxNodes - nFacts;
  const usedSources = new Set();
  for (let i = 0; i < nFacts; i += 1) {
    const id = `f${i}`;
    const source = sourceIds[Math.floor(rand() * nSources)];
    usedSources.add(source);
    commands.push(['ADD_FACT', { id, source, value: 1 + Math.floor(rand() * 5) }]);
    nodeIds.push(id);
  }
  for (let i = 0; i < nDerived; i += 1) {
    const id = `d${i}`;
    const arity = 1 + Math.floor(rand() * 4);
    const inputs = [];
    for (let k = 0; k < arity; k += 1) {
      inputs.push(nodeIds[Math.floor(rand() * nodeIds.length)]);
    }
    const op = rand() < 0.5 ? 'count' : 'sum';
    const min = op === 'count' ? 1 + Math.floor(rand() * arity) : 1 + Math.floor(rand() * 8);
    commands.push(['ADD_DERIVED', { id, op, min, inputs }]);
    nodeIds.push(id);
  }
  for (const src of usedSources) {
    if (rand() < 0.5) commands.push(['REVOKE_SOURCE', { id: src }]);
    if (rand() < 0.2) commands.push(['RESTORE_SOURCE', { id: src }]);
  }
  for (let i = 0; i < nFacts; i += 1) {
    if (rand() < 0.15) commands.push(['DELETE_FACT', { id: `f${i}` }]);
  }
  return { commands, nodeIds };
}
