'use strict';

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateInput(data) {
  if (!isPlainObject(data)) {
    throw new InputError('input must be a JSON object');
  }
  const { accounts, instructions, revocations = [], budget } = data;

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new InputError('accounts must be a non-empty array');
  }
  const accountMap = new Map();
  for (const account of accounts) {
    if (!isPlainObject(account) || typeof account.id !== 'string' || account.id === '') {
      throw new InputError('each account requires a non-empty string id');
    }
    if (typeof account.limit !== 'number' || !Number.isFinite(account.limit) || account.limit < 0) {
      throw new InputError(`account ${account.id}: limit must be a non-negative finite number`);
    }
    if (accountMap.has(account.id)) {
      throw new InputError(`duplicate account id ${account.id}`);
    }
    accountMap.set(account.id, { id: account.id, limit: account.limit });
  }

  if (!Array.isArray(instructions)) {
    throw new InputError('instructions must be an array');
  }
  const instructionMap = new Map();
  for (const instruction of instructions) {
    if (!isPlainObject(instruction) || typeof instruction.id !== 'string' || instruction.id === '') {
      throw new InputError('each instruction requires a non-empty string id');
    }
    if (typeof instruction.from !== 'string' || !accountMap.has(instruction.from)) {
      throw new InputError(`instruction ${instruction.id}: unknown from account ${instruction.from}`);
    }
    if (typeof instruction.to !== 'string' || !accountMap.has(instruction.to)) {
      throw new InputError(`instruction ${instruction.id}: unknown to account ${instruction.to}`);
    }
    if (instruction.from === instruction.to) {
      throw new InputError(`instruction ${instruction.id}: from and to must differ`);
    }
    if (typeof instruction.amount !== 'number' || !Number.isFinite(instruction.amount) || instruction.amount <= 0) {
      throw new InputError(`instruction ${instruction.id}: amount must be a positive finite number`);
    }
    const frozen = instruction.frozen === undefined ? 0 : instruction.frozen;
    if (typeof frozen !== 'number' || !Number.isFinite(frozen) || frozen < 0) {
      throw new InputError(`instruction ${instruction.id}: frozen must be a non-negative finite number`);
    }
    if (instructionMap.has(instruction.id)) {
      throw new InputError(`duplicate instruction id ${instruction.id}`);
    }
    instructionMap.set(instruction.id, {
      id: instruction.id,
      from: instruction.from,
      to: instruction.to,
      amount: instruction.amount,
      frozen,
    });
  }

  if (!Array.isArray(revocations)) {
    throw new InputError('revocations must be an array');
  }
  const revoked = new Set();
  const parsedRevocations = [];
  for (const revocation of revocations) {
    if (!isPlainObject(revocation) || typeof revocation.instruction !== 'string') {
      throw new InputError('each revocation requires an instruction id');
    }
    if (!instructionMap.has(revocation.instruction)) {
      throw new InputError(`revocation references unknown instruction ${revocation.instruction}`);
    }
    if (revoked.has(revocation.instruction)) {
      throw new InputError(`duplicate revocation for instruction ${revocation.instruction}`);
    }
    const time = typeof revocation.time === 'number' ? revocation.time : Date.parse(revocation.time);
    if (!Number.isFinite(time)) {
      throw new InputError(`revocation for ${revocation.instruction}: invalid time`);
    }
    revoked.add(revocation.instruction);
    parsedRevocations.push({
      id: typeof revocation.id === 'string' ? revocation.id : `rev-${parsedRevocations.length + 1}`,
      instruction: revocation.instruction,
      time,
    });
  }

  let budgetValue = budget === undefined ? 100000 : budget;
  if (!Number.isInteger(budgetValue) || budgetValue < 0) {
    throw new InputError('budget must be a non-negative integer');
  }

  // Revocations release the original freezes in reverse chronological order.
  parsedRevocations.sort((a, b) => b.time - a.time);
  const revocationOrder = parsedRevocations.map((revocation, index) => ({
    seq: index + 1,
    id: revocation.id,
    instruction: revocation.instruction,
    time: revocation.time,
  }));

  return {
    accounts: accountMap,
    instructions: [...instructionMap.values()],
    revocationOrder,
    revoked,
    budget: budgetValue,
  };
}

module.exports = { InputError, validateInput };
