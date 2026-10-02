import { EngineError } from './errors.js';

export function validateProtocol(proto) {
  if (!proto || typeof proto !== 'object' || !Array.isArray(proto.steps) || proto.steps.length === 0) {
    throw new EngineError('PROTOCOL_INVALID', 'protocol must contain a non-empty "steps" array');
  }
  const ids = new Set();
  for (const [i, s] of proto.steps.entries()) {
    if (!s || typeof s.id !== 'string' || s.id === '') {
      throw new EngineError('PROTOCOL_INVALID', `step #${i} is missing a non-empty "id"`);
    }
    if (ids.has(s.id)) throw new EngineError('PROTOCOL_INVALID', `duplicate step id "${s.id}"`);
    ids.add(s.id);
    if (typeof s.op !== 'string' || s.op === '') {
      throw new EngineError('PROTOCOL_INVALID', `step "${s.id}" is missing a non-empty "op"`);
    }
    s.requires = s.requires ?? [];
    s.produces = s.produces ?? [];
    if (!Array.isArray(s.requires) || !Array.isArray(s.produces)) {
      throw new EngineError('PROTOCOL_INVALID', `step "${s.id}": requires/produces must be arrays`);
    }
    if (s.timeout != null && (typeof s.timeout !== 'number' || s.timeout < 0)) {
      throw new EngineError('PROTOCOL_INVALID', `step "${s.id}": timeout must be a non-negative number`);
    }
  }
  return proto;
}

// Builds the dependency DAG from requires/produces wiring, layers it
// (independent steps in one layer may run in parallel) and marks joins
// (steps with 2+ upstream dependencies, which must wait for all of them).
export function buildDag(proto) {
  validateProtocol(proto);
  const steps = proto.steps;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const inputs = new Set(proto.inputs ?? []);

  const producerOf = new Map();
  for (const s of steps) {
    for (const p of s.produces) {
      if (producerOf.has(p)) {
        throw new EngineError('PROTOCOL_INVALID', `artifact "${p}" is produced by more than one step`);
      }
      producerOf.set(p, s.id);
    }
  }

  const deps = new Map(steps.map((s) => [s.id, []]));
  const downstream = new Map(steps.map((s) => [s.id, []]));
  for (const s of steps) {
    const seen = new Set();
    for (const r of s.requires) {
      if (producerOf.has(r)) {
        const up = producerOf.get(r);
        if (!seen.has(up)) {
          seen.add(up);
          deps.get(s.id).push(up);
          downstream.get(up).push(s.id);
        }
      } else if (!inputs.has(r)) {
        throw new EngineError(
          'PROTOCOL_INVALID',
          `step "${s.id}" requires "${r}" which is neither produced nor declared in "inputs"`,
        );
      }
    }
  }

  const joins = new Set(steps.filter((s) => deps.get(s.id).length >= 2).map((s) => s.id));

  const indeg = new Map(steps.map((s) => [s.id, deps.get(s.id).length]));
  const layers = [];
  let current = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const seen = new Set();
  while (current.length > 0) {
    layers.push(current);
    const next = [];
    for (const id of current) {
      seen.add(id);
      for (const d of downstream.get(id)) {
        indeg.set(d, indeg.get(d) - 1);
        if (indeg.get(d) === 0) next.push(d);
      }
    }
    current = next;
  }
  if (seen.size !== steps.length) {
    throw new EngineError('PROTOCOL_INVALID', 'protocol contains a dependency cycle');
  }

  return { proto, steps, byId, inputs, producerOf, deps, downstream, layers, joins };
}
