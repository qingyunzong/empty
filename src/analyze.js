import { EXIT, ReplayError } from './errors.js';
import {
  validateEvents,
  topoSort,
  computePasts,
  linearExtensions,
  interactionKeys,
  isConcurrent,
} from './model.js';
import { normalizeConfig, simulate, signature } from './simulate.js';

export function prepare(events) {
  const byId = validateEvents(events);
  const pastOf = computePasts(byId);
  const canonical = topoSort(events);
  return { byId, pastOf, canonical };
}

function swappedExtensions(canonical, a, b, pastOf) {
  const prefixIds = new Set([...pastOf.get(a.id), ...pastOf.get(b.id)]);
  prefixIds.delete(a.id);
  prefixIds.delete(b.id);
  const prefix = canonical.filter((e) => prefixIds.has(e.id));
  const rest = canonical.filter((e) => !prefixIds.has(e.id) && e.id !== a.id && e.id !== b.id);
  return [
    [...prefix, a, b, ...rest],
    [...prefix, b, a, ...rest],
  ];
}

function pairwiseWitness(events, ctx, config, canonical) {
  const { byId, pastOf } = ctx;
  const sorted = [...events].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (!isConcurrent(a, b, pastOf)) continue;
      const keysA = interactionKeys(a, byId);
      if (!keysA.some((k) => interactionKeys(b, byId).includes(k))) continue;
      const [e1, e2] = swappedExtensions(canonical, a, b, pastOf);
      if (signature(simulate(e1, ctx, config)) !== signature(simulate(e2, ctx, config))) {
        return { a: a.id, b: b.id };
      }
    }
  }
  return null;
}

function orderWitness(ext1, ext2) {
  const pos1 = new Map(ext1.map((e, i) => [e.id, i]));
  const pos2 = new Map(ext2.map((e, i) => [e.id, i]));
  const ids = ext1.map((e) => e.id).sort();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const before1 = pos1.get(ids[i]) < pos1.get(ids[j]);
      const before2 = pos2.get(ids[i]) < pos2.get(ids[j]);
      if (before1 !== before2) return { a: ids[i], b: ids[j] };
    }
  }
  return null;
}

const ENUMERATION_THRESHOLD = 8;

export function findConflict(events, ctx, config, canonical) {
  const { byId } = ctx;
  if (events.length <= ENUMERATION_THRESHOLD) {
    const baseSig = signature(simulate(canonical, ctx, config));
    let differing = null;
    for (const ext of linearExtensions(events, byId)) {
      if (signature(simulate(ext, ctx, config)) !== baseSig) {
        differing = ext;
        break;
      }
    }
    if (!differing) return null;
    return (
      pairwiseWitness(events, ctx, config, canonical) ??
      orderWitness(canonical, differing) ??
      { a: differing[0].id, b: differing[1].id }
    );
  }
  return pairwiseWitness(events, ctx, config, canonical);
}

export function analyze(events, rawConfig = {}) {
  const { byId, pastOf, canonical } = prepare(events);
  const config = normalizeConfig(rawConfig);
  const ctx = { byId, pastOf };
  const conflict = findConflict(events, ctx, config, canonical);
  const outcome = simulate(canonical, ctx, config);
  let error = null;
  if (conflict) {
    error = {
      code: EXIT.CONFLICT,
      message: `conflict: concurrent events ${conflict.a} and ${conflict.b} are not causally comparable; refusing to pick an arbitrary order`,
      details: { ...conflict },
    };
  } else if (outcome.firstError) {
    error = outcome.firstError;
  }
  return { outcome, conflict, error, canonical: canonical.map((e) => e.id) };
}

export function enumerateOutcomes(events, rawConfig = {}) {
  const { byId, pastOf } = prepare(events);
  const config = normalizeConfig(rawConfig);
  const ctx = { byId, pastOf };
  const sigs = new Set();
  for (const ext of linearExtensions(events, byId)) {
    sigs.add(signature(simulate(ext, ctx, config)));
  }
  return sigs;
}

export function buildCompensation(events, targetId) {
  const byId = validateEvents(events);
  const target = byId.get(targetId);
  if (!target) throw new ReplayError(EXIT.USAGE, `unknown target ${targetId}`);
  if (target.type !== 'measure') {
    throw new ReplayError(EXIT.USAGE, `target ${targetId} is a ${target.type}; only measurements can be compensated`);
  }
  const dependedOn = new Set(events.flatMap((e) => e.deps));
  const leaves = events.filter((e) => !dependedOn.has(e.id)).map((e) => e.id);
  const deps = [...new Set([targetId, ...leaves])].sort();
  let id = `cmp-${targetId}`;
  for (let n = 2; byId.has(id); n += 1) id = `cmp-${targetId}-${n}`;
  return { id, type: 'compensate', target: targetId, deps };
}
