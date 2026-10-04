'use strict';

const { computeFreezes } = require('../src/solver');

const VALUES = ['FULL', 'NET', 'PEND'];
const EPS = 1e-9;

// Brute-force oracle: an assignment is valid iff it satisfies every constraint.
function assignmentValid(problem, assignment) {
  const { accounts, instructions, revocations } = problem;
  const revoked = new Set(revocations.map((r) => r.instruction));
  for (let i = 0; i < instructions.length; i += 1) {
    const instruction = instructions[i];
    const disposition = assignment[i];
    if (revoked.has(instruction.id) && disposition !== 'PEND') return false;
    if (instruction.mandatory && disposition === 'PEND') return false;
    if (disposition === 'NET') {
      const hasNettedPartner = instructions.some(
        (other, j) =>
          j !== i &&
          other.from === instruction.to &&
          other.to === instruction.from &&
          assignment[j] === 'NET',
      );
      if (!hasNettedPartner) return false;
    }
  }
  const freezes = computeFreezes(accounts, instructions, assignment);
  for (const account of accounts) {
    if (freezes.get(account.id) > account.limit + EPS) return false;
  }
  return true;
}

// Enumerate every disposition assignment (3^n) and collect the valid ones.
function enumerateValid(problem) {
  const count = problem.instructions.length;
  const valid = [];
  const current = new Array(count);
  (function recurse(i) {
    if (i === count) {
      if (assignmentValid(problem, current)) valid.push(current.slice());
      return;
    }
    for (const value of VALUES) {
      current[i] = value;
      recurse(i + 1);
    }
  })(0);
  return valid;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random small problem: <= 3 accounts, <= 5 instructions.
function randomProblem(rng) {
  const accountCount = 2 + Math.floor(rng() * 2);
  const accounts = [];
  for (let k = 0; k < accountCount; k += 1) {
    accounts.push({ id: String.fromCharCode(65 + k), limit: Math.floor(rng() * 16) * 10 });
  }
  const instructionCount = 1 + Math.floor(rng() * 5);
  const instructions = [];
  for (let k = 0; k < instructionCount; k += 1) {
    let from = accounts[Math.floor(rng() * accountCount)].id;
    let to = accounts[Math.floor(rng() * accountCount)].id;
    while (to === from) to = accounts[Math.floor(rng() * accountCount)].id;
    instructions.push({
      id: `I${k + 1}`,
      from,
      to,
      amount: (1 + Math.floor(rng() * 10)) * 10,
      mandatory: rng() < 0.3,
    });
  }
  const revocations = [];
  let seq = 1;
  for (const instruction of instructions) {
    if (rng() < 0.2) {
      revocations.push({ seq, instruction: instruction.id });
      seq += 1;
    }
  }
  return { accounts, instructions, revocations, budget: 1000000 };
}

module.exports = { assignmentValid, enumerateValid, randomProblem, mulberry32, VALUES };
