'use strict';
const { hashValue, coreOf, checkInvariants } = require('./state');
const { applyStep } = require('./transitions');

function initialState(norm) {
  const balances = {};
  const frozen = {};
  for (const account of norm.accounts) {
    balances[account] = norm.initialBalances[account];
    frozen[account] = 0;
  }
  return {
    balances,
    frozen,
    holds: {},
    frozenAccounts: [...norm.initialFrozen].sort(),
    rejected: [],
  };
}

function totalOf(norm) {
  let total = 0;
  for (const account of norm.accounts) total += norm.initialBalances[account];
  return total;
}

function stepLabel(norm, actorIndex, stepIndex) {
  return `${norm.actors[actorIndex].name}#${stepIndex}`;
}

function configKey(state, pointers) {
  return hashValue(coreOf(state)) + '|' + pointers.join(',');
}

function findCounterexample(norm, initial, total) {
  const actors = norm.actors;
  const visited = new Set();
  let found = null;
  const dfs = (state, pointers, sequence) => {
    if (found) return;
    const key = configKey(state, pointers);
    if (visited.has(key)) return;
    visited.add(key);
    const violations = checkInvariants(state, total);
    if (violations.length > 0) {
      found = {
        sequence,
        steps: sequence.map((label, i) => {
          const [actorName, idx] = label.split('#');
          const actor = norm.actors.find((a) => a.name === actorName);
          return { label, ...actor.steps[Number(idx)] };
        }),
        violations,
        state: coreOf(state),
        stateHash: hashValue(coreOf(state)),
        rejected: state.rejected,
      };
      return;
    }
    for (let ai = 0; ai < actors.length; ai++) {
      const si = pointers[ai];
      if (si >= actors[ai].steps.length) continue;
      const label = stepLabel(norm, ai, si);
      const { state: next } = applyStep(state, actors[ai].steps[si], label);
      const nextPointers = pointers.slice();
      nextPointers[ai]++;
      dfs(next, nextPointers, [...sequence, label]);
      if (found) return;
    }
  };
  dfs(initial, actors.map(() => 0), []);
  return found;
}

function explore(norm) {
  const initial = initialState(norm);
  const total = totalOf(norm);
  const actors = norm.actors;
  const startPointers = actors.map(() => 0);

  const visited = new Set([configKey(initial, startPointers)]);
  const terminalHashes = new Set();
  let violating = 0;
  if (checkInvariants(initial, total).length > 0) violating++;

  const queue = [{ state: initial, pointers: startPointers }];
  while (queue.length > 0) {
    const { state, pointers } = queue.shift();
    let terminal = true;
    for (let ai = 0; ai < actors.length; ai++) {
      const si = pointers[ai];
      if (si >= actors[ai].steps.length) continue;
      terminal = false;
      const label = stepLabel(norm, ai, si);
      const { state: next } = applyStep(state, actors[ai].steps[si], label);
      const nextPointers = pointers.slice();
      nextPointers[ai]++;
      const key = configKey(next, nextPointers);
      if (!visited.has(key)) {
        visited.add(key);
        if (checkInvariants(next, total).length > 0) violating++;
        queue.push({ state: next, pointers: nextPointers });
      }
    }
    if (terminal) terminalHashes.add(hashValue(coreOf(state)));
  }

  const counterexample = violating > 0 ? findCounterexample(norm, initial, total) : null;
  const certificate = violating === 0
    ? {
        algorithm: 'exhaustive-interleaving-bfs',
        invariants: ['CONSERVATION', 'HOLD_LE_BALANCE', 'NONNEGATIVE_FROZEN'],
        initialTotal: total,
        reachableStates: visited.size,
        statesHash: hashValue([...visited].sort()),
        finalStatesHash: hashValue([...terminalHashes].sort()),
      }
    : null;

  return {
    reachable: visited.size,
    violating,
    counterexample,
    certificate,
    terminals: [...terminalHashes].sort(),
  };
}

module.exports = { explore, initialState, totalOf, stepLabel };
