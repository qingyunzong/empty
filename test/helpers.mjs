import { applyStep, checkInvariants, initialState } from '../src/state.js';

// Independent enumerator used to cross-check the explorer: generates ALL
// permutations of the step ids and keeps only those preserving every actor's
// program order. Deliberately shares no code with src/explore.js.
export function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const result = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) {
      result.push([items[i], ...perm]);
    }
  }
  return result;
}

function isSubsequence(order, sequence) {
  let i = 0;
  for (const id of sequence) {
    if (id === order[i]) i += 1;
  }
  return i === order.length;
}

export function allInterleavings(plan) {
  const ids = plan.actors.flatMap((actor) => actor.steps.map((step) => step.id));
  const orders = plan.actors.map((actor) => actor.steps.map((step) => step.id));
  return permutations(ids).filter((seq) => orders.every((order) => isSubsequence(order, seq)));
}

export function stepById(plan, id) {
  for (const actor of plan.actors) {
    for (const step of actor.steps) {
      if (step.id === id) return step;
    }
  }
  throw new Error(`unknown step id: ${id}`);
}

// Replays a full step sequence from the initial state, reporting whether any
// invariant was violated and the index of the first violating step.
export function replay(plan, sequence) {
  const state = initialState(plan);
  let violated = checkInvariants(state, plan.initialTotal).length > 0;
  let firstViolationAt = violated ? -1 : null;
  sequence.forEach((id, index) => {
    applyStep(state, stepById(plan, id));
    if (!violated && checkInvariants(state, plan.initialTotal).length > 0) {
      violated = true;
      firstViolationAt = index;
    }
  });
  return { state, violated, firstViolationAt };
}

export function compareSequences(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}
