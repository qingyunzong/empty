'use strict';

const DISPOSITIONS = ['FULL', 'NET', 'PEND'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(message) {
  throw new ValidationError(message);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateProblem(raw) {
  if (!isPlainObject(raw)) fail('input must be a JSON object');
  const { accounts, instructions, revocations, budget, previous } = raw;

  if (!Array.isArray(accounts) || accounts.length === 0) {
    fail('accounts must be a non-empty array');
  }
  const accountIds = new Set();
  const normAccounts = accounts.map((account, k) => {
    if (!isPlainObject(account)) fail(`accounts[${k}] must be an object`);
    if (typeof account.id !== 'string' || account.id.length === 0) {
      fail(`accounts[${k}].id must be a non-empty string`);
    }
    if (accountIds.has(account.id)) fail(`duplicate account id "${account.id}"`);
    accountIds.add(account.id);
    if (!isFiniteNumber(account.limit) || account.limit < 0) {
      fail(`account "${account.id}": limit must be a non-negative finite number`);
    }
    return { id: account.id, limit: account.limit };
  });

  if (!Array.isArray(instructions)) fail('instructions must be an array');
  const instructionIds = new Set();
  const normInstructions = instructions.map((instruction, k) => {
    if (!isPlainObject(instruction)) fail(`instructions[${k}] must be an object`);
    const { id, from, to, amount, mandatory } = instruction;
    if (typeof id !== 'string' || id.length === 0) {
      fail(`instructions[${k}].id must be a non-empty string`);
    }
    if (instructionIds.has(id)) fail(`duplicate instruction id "${id}"`);
    instructionIds.add(id);
    if (!accountIds.has(from)) fail(`instruction "${id}" references unknown account "${from}"`);
    if (!accountIds.has(to)) fail(`instruction "${id}" references unknown account "${to}"`);
    if (from === to) fail(`instruction "${id}" has identical payer and payee "${from}"`);
    if (!isFiniteNumber(amount) || amount <= 0) {
      fail(`instruction "${id}": amount must be a positive finite number`);
    }
    if (mandatory !== undefined && typeof mandatory !== 'boolean') {
      fail(`instruction "${id}": mandatory must be a boolean`);
    }
    return { id, from, to, amount, mandatory: Boolean(mandatory) };
  });

  let normRevocations = [];
  if (revocations !== undefined) {
    if (!Array.isArray(revocations)) fail('revocations must be an array');
    const seenSeq = new Set();
    const seenTarget = new Set();
    normRevocations = revocations.map((revocation, k) => {
      if (!isPlainObject(revocation)) fail(`revocations[${k}] must be an object`);
      const { seq, instruction } = revocation;
      if (!Number.isInteger(seq) || seq <= 0) {
        fail(`revocations[${k}].seq must be a positive integer`);
      }
      if (seenSeq.has(seq)) fail(`duplicate revocation seq ${seq}`);
      seenSeq.add(seq);
      if (typeof instruction !== 'string' || !instructionIds.has(instruction)) {
        fail(`revocation seq ${seq} references unknown instruction "${instruction}"`);
      }
      if (seenTarget.has(instruction)) {
        fail(`duplicate revocation of instruction "${instruction}"`);
      }
      seenTarget.add(instruction);
      return { seq, instruction };
    });
  }

  let normBudget = 1000000;
  if (budget !== undefined) {
    if (!Number.isInteger(budget) || budget < 0) {
      fail('budget must be a non-negative integer');
    }
    normBudget = budget;
  }

  let normPrevious = null;
  if (previous !== undefined && previous !== null) {
    if (!isPlainObject(previous)) fail('previous must be an object');
    const { dispositions } = previous;
    if (!isPlainObject(dispositions)) fail('previous.dispositions must be an object');
    for (const [id, value] of Object.entries(dispositions)) {
      if (!instructionIds.has(id)) {
        fail(`previous.dispositions references unknown instruction "${id}"`);
      }
      if (!DISPOSITIONS.includes(value)) {
        fail(`previous.dispositions["${id}"] must be one of ${DISPOSITIONS.join(', ')}`);
      }
    }
    normPrevious = { dispositions: { ...dispositions } };
  }

  return {
    accounts: normAccounts,
    instructions: normInstructions,
    revocations: normRevocations,
    budget: normBudget,
    previous: normPrevious,
  };
}

module.exports = { validateProblem, ValidationError, DISPOSITIONS };
