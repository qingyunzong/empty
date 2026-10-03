import { createHash } from 'node:crypto';
import { applyStep, canonicalize, checkInvariants, cloneState, hashState, initialState } from './state.js';

// Enumerates every interleaving of the actors' steps that preserves each
// actor's program order, checking the safety invariants at every state.
//
// Returns:
//   reachable        - number of distinct (actor positions, ledger) states
//   interleavings    - number of complete step sequences
//   violating        - number of complete sequences passing through a violation
//   violatingStates  - number of distinct states that break an invariant
//   counterexample   - lexicographically smallest step sequence (by step id)
//                      whose prefix first reaches a violating state, or null
//   certificate      - reproducible safety certificate when nothing violates
export function explore(plan) {
  const seen = new Set();
  const terminalHashes = new Set();
  let reachable = 0;
  let interleavings = 0;
  let violating = 0;
  let violatingStates = 0;
  let counterexample = null;

  const visit = (state, positions, path, pathViolated) => {
    const key = `${positions.join(',')}|${hashState(state)}`;
    const isNew = !seen.has(key);
    if (isNew) {
      seen.add(key);
      reachable += 1;
    }
    const violations = checkInvariants(state, plan.initialTotal);
    if (violations.length > 0 && isNew) {
      violatingStates += 1;
    }
    let violated = pathViolated;
    if (violations.length > 0 && !pathViolated) {
      violated = true;
      // Depth-first pre-order with step ids tried in ascending order visits
      // root-to-node paths in lexicographic order, so the first violation
      // found is the lexicographically smallest counterexample.
      if (counterexample === null) {
        counterexample = {
          sequence: [...path],
          violations,
          state: cloneState(state),
        };
      }
    }

    const options = [];
    plan.actors.forEach((actor, index) => {
      if (positions[index] < actor.steps.length) {
        options.push({ actorIndex: index, step: actor.steps[positions[index]] });
      }
    });
    if (options.length === 0) {
      interleavings += 1;
      if (violated) violating += 1;
      terminalHashes.add(hashState(state));
      return;
    }
    options.sort((a, b) => (a.step.id < b.step.id ? -1 : 1));
    for (const { actorIndex, step } of options) {
      const nextState = cloneState(state);
      applyStep(nextState, step);
      const nextPositions = positions.slice();
      nextPositions[actorIndex] += 1;
      path.push(step.id);
      visit(nextState, nextPositions, path, violated);
      path.pop();
    }
  };

  visit(initialState(plan), plan.actors.map(() => 0), [], false);

  const result = {
    reachable,
    interleavings,
    violating,
    violatingStates,
    counterexample,
    certificate: null,
  };

  if (violating === 0) {
    const finalStateHashes = [...terminalHashes].sort();
    result.certificate = {
      type: 'SAFE_CERTIFICATE',
      hashAlgorithm: 'sha256',
      planHash: hashState({
        accounts: plan.accounts,
        actors: plan.actors,
        initialTotal: plan.initialTotal,
      }),
      reachable,
      interleavings,
      terminalStates: finalStateHashes.length,
      finalStateHashes,
      finalStateHash:
        finalStateHashes.length === 1
          ? finalStateHashes[0]
          : createHash('sha256').update(canonicalize(finalStateHashes)).digest('hex'),
    };
  }
  return result;
}
