'use strict';

const crypto = require('crypto');
const {
  initialState,
  canonicalAction,
  listActions,
  applyAction,
  violates,
  stateKey,
} = require('./machine');

const COVERAGE_ACTIONS = ['approve', 'submit'];

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function findMinimalDepth(spec) {
  const start = initialState();
  const seen = new Set([stateKey(start)]);
  let level = [start];
  let statesExplored = 1;
  for (let depth = 1; depth <= spec.bound; depth++) {
    const next = [];
    for (const state of level) {
      for (const action of listActions(spec, state)) {
        const successor = applyAction(spec, state, action);
        if (successor === null) continue;
        const key = stateKey(successor);
        if (seen.has(key)) continue;
        seen.add(key);
        statesExplored++;
        if (violates(spec, successor)) {
          return { depth, statesExplored };
        }
        next.push(successor);
      }
    }
    level = next;
  }
  return { depth: null, statesExplored };
}

function collectAtDepth(spec, state, depth, prefix, out, limit) {
  for (const action of listActions(spec, state)) {
    const successor = applyAction(spec, state, action);
    if (successor === null) continue;
    const violation = violates(spec, successor);
    if (depth === 1) {
      if (violation) {
        out.push(prefix.concat([action]));
        if (out.length >= limit) return;
      }
      continue;
    }
    if (violation) continue;
    collectAtDepth(spec, successor, depth - 1, prefix.concat([action]), out, limit);
    if (out.length >= limit) return;
  }
}

function buildCombinations(spec) {
  const combinations = [];
  for (const subject of spec.subjects) {
    for (const action of COVERAGE_ACTIONS) {
      for (const amount of spec.amounts) {
        combinations.push(`${subject}|${action}|${amount}`);
      }
    }
  }
  return combinations;
}

function certificatePayload(spec, combinations) {
  return {
    amounts: spec.amounts,
    bound: spec.bound,
    combinations,
    invariant: spec.invariant,
    policy: {
      roles: spec.roles,
      rules: spec.rules,
      subjectRoles: spec.subjectRoles,
    },
    subjects: spec.subjects,
  };
}

function buildProof(spec, statesExplored) {
  const combinations = buildCombinations(spec);
  const payload = certificatePayload(spec, combinations);
  const digest = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  return {
    result: 'proof',
    bound: spec.bound,
    subjects: spec.subjects,
    amounts: spec.amounts,
    invariant: spec.invariant,
    policy: payload.policy,
    coverage: {
      subjects: spec.subjects.length,
      actions: COVERAGE_ACTIONS.length,
      amounts: spec.amounts.length,
      combinations: combinations.length,
    },
    combinations,
    statesExplored,
    certificate: `sha256:${digest}`,
  };
}

function search(spec) {
  const { depth, statesExplored } = findMinimalDepth(spec);
  if (depth === null) {
    return buildProof(spec, statesExplored);
  }
  const found = [];
  collectAtDepth(spec, initialState(), depth, [], found, 1);
  const sequence = found[0];
  const replay = sequence.reduce(
    (state, action) => applyAction(spec, state, action),
    initialState()
  );
  return {
    result: 'counterexample',
    invariant: spec.invariant.type,
    length: depth,
    sequence,
    canonical: sequence.map(canonicalAction),
    violation: violates(spec, replay),
    statesExplored,
  };
}

function enumerateMinimalCounterexamples(spec) {
  const { depth } = findMinimalDepth(spec);
  if (depth === null) return [];
  const out = [];
  collectAtDepth(spec, initialState(), depth, [], out, Number.MAX_SAFE_INTEGER);
  return out;
}

function verifyCertificate(spec, proof) {
  if (!proof || proof.result !== 'proof') return false;
  const combinations = buildCombinations(spec);
  if (JSON.stringify(combinations) !== JSON.stringify(proof.combinations)) return false;
  const payload = certificatePayload(spec, combinations);
  const digest = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  return proof.certificate === `sha256:${digest}`;
}

module.exports = {
  search,
  enumerateMinimalCounterexamples,
  verifyCertificate,
  buildCombinations,
  certificatePayload,
  stableStringify,
  COVERAGE_ACTIONS,
};
