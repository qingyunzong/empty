'use strict';

const { createHash } = require('node:crypto');

class NettingError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'NettingError';
    this.code = code;
  }
}

function hashInstruction(instruction) {
  const canonical = JSON.stringify({
    amount: instruction.amount,
    id: instruction.id,
    payee: instruction.payee,
    payer: instruction.payer,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function validateInstruction(instruction) {
  if (instruction === null || typeof instruction !== 'object') {
    throw new NettingError('invalid-input', 'instruction must be an object');
  }
  const { id, payer, payee, amount } = instruction;
  if (typeof id !== 'string' || id.length === 0) {
    throw new NettingError('invalid-input', 'instruction id must be a non-empty string');
  }
  if (typeof payer !== 'string' || payer.length === 0) {
    throw new NettingError('invalid-input', 'payer must be a non-empty string');
  }
  if (typeof payee !== 'string' || payee.length === 0) {
    throw new NettingError('invalid-input', 'payee must be a non-empty string');
  }
  if (payer === payee) {
    throw new NettingError('invalid-input', 'payer and payee must differ');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new NettingError('invalid-input', 'amount must be a positive finite number');
  }
}

function createState() {
  return { instructions: [], cancels: [] };
}

function findInstruction(state, id) {
  return state.instructions.find((instruction) => instruction.id === id);
}

function findCancel(state, id) {
  return state.cancels.find((cancel) => cancel.id === id);
}

function addInstruction(state, instruction) {
  validateInstruction(instruction);
  const record = {
    id: instruction.id,
    payer: instruction.payer,
    payee: instruction.payee,
    amount: instruction.amount,
  };
  const existing = findInstruction(state, record.id);
  if (existing) {
    if (hashInstruction(existing) !== hashInstruction(record)) {
      throw new NettingError(
        'conflicting-instruction',
        `instruction ${record.id} already exists with different content`,
      );
    }
    return { instruction: existing, added: false };
  }
  state.instructions.push(record);
  return { instruction: record, added: true };
}

function cancelInstruction(state, id, observedHash) {
  const instruction = findInstruction(state, id);
  if (!instruction) {
    throw new NettingError('unknown-instruction', `no instruction with id ${id}`);
  }
  const actualHash = hashInstruction(instruction);
  if (observedHash !== undefined && observedHash !== actualHash) {
    throw new NettingError(
      'hash-mismatch',
      `observed hash does not match instruction ${id}`,
    );
  }
  const existing = findCancel(state, id);
  if (existing) {
    return { tombstone: existing, applied: false };
  }
  const tombstone = { id, hash: observedHash === undefined ? actualHash : observedHash };
  state.cancels.push(tombstone);
  return { tombstone, applied: true };
}

function mergeState(state, other) {
  if (other === null || typeof other !== 'object') {
    throw new NettingError('invalid-input', 'merge payload must be an object');
  }
  const incomingInstructions = Array.isArray(other.instructions) ? other.instructions : [];
  const incomingCancels = Array.isArray(other.cancels) ? other.cancels : [];
  for (const instruction of incomingInstructions) {
    addInstruction(state, instruction);
  }
  const tombstones = [];
  for (const cancel of incomingCancels) {
    if (cancel === null || typeof cancel !== 'object' || typeof cancel.id !== 'string') {
      throw new NettingError('invalid-input', 'cancel events must reference an instruction id');
    }
    const result = cancelInstruction(state, cancel.id, cancel.hash);
    tombstones.push(result.tombstone);
  }
  return { tombstones };
}

function activeInstructions(state) {
  const cancelled = new Set(state.cancels.map((cancel) => cancel.id));
  return state.instructions
    .filter((instruction) => !cancelled.has(instruction.id))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function computeNets(state) {
  const nets = {};
  for (const instruction of activeInstructions(state)) {
    nets[instruction.payer] = (nets[instruction.payer] || 0) + instruction.amount;
    nets[instruction.payee] = (nets[instruction.payee] || 0) - instruction.amount;
  }
  return nets;
}

function settle(state, budgets) {
  const budgetMap = budgets || {};
  const nets = computeNets(state);
  const parties = Array.from(
    new Set([...Object.keys(nets), ...Object.keys(budgetMap)]),
  ).sort();
  const budgetResults = {};
  let withinBudget = true;
  for (const party of parties) {
    const net = nets[party] || 0;
    const budget = Object.prototype.hasOwnProperty.call(budgetMap, party)
      ? budgetMap[party]
      : null;
    const ok = budget === null || net <= budget;
    if (!ok) withinBudget = false;
    budgetResults[party] = { net, budget, withinBudget: ok };
  }
  return {
    status: withinBudget ? 'settled' : 'blocked',
    settled: withinBudget,
    instructions: activeInstructions(state).map((instruction) => ({
      ...instruction,
      hash: hashInstruction(instruction),
    })),
    nets,
    budgets: budgetResults,
  };
}

module.exports = {
  NettingError,
  hashInstruction,
  createState,
  addInstruction,
  cancelInstruction,
  mergeState,
  activeInstructions,
  computeNets,
  settle,
};
