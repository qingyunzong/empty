'use strict';

const { InputError } = require('./errors');
const { validateMachine, validateTaskCovers } = require('./dfa');
const { compare } = require('./equiv');
const { minCover } = require('./cover');

function runCheck(oldRaw, newRaw, budget, mOpt) {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new InputError(`invalid budget: ${JSON.stringify(budget)} (must be a non-negative integer)`);
  }
  const oldM = validateMachine(oldRaw, 'old');
  const newM = validateMachine(newRaw, 'new');
  const sortedOld = [...oldM.alphabet].sort();
  const sortedNew = [...newM.alphabet].sort();
  if (sortedOld.length !== sortedNew.length || sortedOld.some((s, i) => s !== sortedNew[i])) {
    throw new InputError('alphabets of old and new machines differ');
  }
  validateTaskCovers(newM.tasks, new Set(oldM.states));
  // Default horizon: any shortest distinguishing string is strictly shorter
  // than the number of reachable product states, so |Qold| * |Qnew| is a
  // safe bound for full (unbounded) equivalence.
  const m = mOpt === undefined ? oldM.states.length * newM.states.length : mOpt;
  if (!Number.isInteger(m) || m < 0) {
    throw new InputError(`invalid m: ${JSON.stringify(mOpt)} (must be a non-negative integer)`);
  }
  const res = compare(oldM, newM, m);
  const result = {
    equal: res.equal,
    witness: res.witness,
    diffStates: res.diffStates,
    tasks: [],
    cost: 0,
    feasible: true,
  };
  if (!res.equal) {
    const cover = minCover(res.diffStates, newM.tasks);
    if (cover === null || cover.cost > budget) {
      result.feasible = false;
      return { result, m };
    }
    result.tasks = cover.tasks;
    result.cost = cover.cost;
  }
  return { result, m };
}

module.exports = { runCheck };
