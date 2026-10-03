'use strict';

const STAGE_TYPES = ['trade', 'fee', 'freeze', 'settle'];
const STAGE_TYPE_SET = new Set(STAGE_TYPES);
const STAGE_STATUSES = new Set(['completed', 'reconciled']);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(message) {
  throw new ValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireId(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function validateStage(raw, txId, index) {
  const path = `transactions[${txId}].stages[${index}]`;
  if (!isPlainObject(raw)) fail(`${path} must be an object`);
  const id = requireId(raw.id, `${path}.id`);
  if (!STAGE_TYPE_SET.has(raw.type)) {
    fail(`${path}.type must be one of: ${STAGE_TYPES.join(', ')}`);
  }
  const account = requireId(raw.account, `${path}.account`);
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0) {
    fail(`${path}.amount must be a positive finite number`);
  }
  const status = raw.status === undefined ? 'completed' : raw.status;
  if (!STAGE_STATUSES.has(status)) {
    fail(`${path}.status must be one of: completed, reconciled`);
  }
  const dependsOn = raw.dependsOn === undefined ? [] : raw.dependsOn;
  if (
    !Array.isArray(dependsOn) ||
    dependsOn.some((dep) => typeof dep !== 'string' || dep.length === 0)
  ) {
    fail(`${path}.dependsOn must be an array of stage ids`);
  }
  return {
    id,
    txId,
    type: raw.type,
    account,
    amount: raw.amount,
    status,
    dependsOn: [...new Set(dependsOn)],
    children: [],
    index,
  };
}

function topoOrderChildrenFirst(stages, txId) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const indegree = new Map(stages.map((stage) => [stage.id, 0]));
  for (const stage of stages) {
    for (const parentId of stage.dependsOn) {
      const parent = byId.get(parentId);
      if (!parent) {
        fail(`transactions[${txId}].stages[${stage.id}].dependsOn references unknown stage "${parentId}"`);
      }
      if (parent.id === stage.id) {
        fail(`transactions[${txId}].stages[${stage.id}] cannot depend on itself`);
      }
      parent.children.push(stage.id);
      indegree.set(stage.id, indegree.get(stage.id) + 1);
    }
  }
  const ready = stages.filter((stage) => indegree.get(stage.id) === 0).map((stage) => stage.id);
  const order = [];
  while (ready.length > 0) {
    ready.sort((a, b) => byId.get(a).index - byId.get(b).index);
    const id = ready.shift();
    order.push(id);
    for (const childId of byId.get(id).children) {
      const next = indegree.get(childId) - 1;
      indegree.set(childId, next);
      if (next === 0) ready.push(childId);
    }
  }
  if (order.length !== stages.length) {
    fail(`transactions[${txId}] has cyclic stage dependencies`);
  }
  // Kahn above yields parents-first; compensation runs children-first.
  return order.reverse();
}

function validateTransaction(raw, index) {
  const path = `transactions[${index}]`;
  if (!isPlainObject(raw)) fail(`${path} must be an object`);
  const id = requireId(raw.id, `${path}.id`);
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    fail(`${path}.stages must be a non-empty array`);
  }
  const stages = raw.stages.map((stage, i) => validateStage(stage, id, i));
  const seen = new Set();
  for (const stage of stages) {
    if (seen.has(stage.id)) fail(`${path}.stages has duplicate id "${stage.id}"`);
    seen.add(stage.id);
  }
  const order = topoOrderChildrenFirst(stages, id);
  return { id, stages, stageById: new Map(stages.map((s) => [s.id, s])), order };
}

function validateBatch(raw, index) {
  const path = `batches[${index}]`;
  if (!isPlainObject(raw)) fail(`${path} must be an object`);
  const id = requireId(raw.id, `${path}.id`);
  if (
    !Array.isArray(raw.domains) ||
    raw.domains.length === 0 ||
    raw.domains.some((d) => !STAGE_TYPE_SET.has(d))
  ) {
    fail(`${path}.domains must be a non-empty array of: ${STAGE_TYPES.join(', ')}`);
  }
  if (!isPlainObject(raw.quotas)) fail(`${path}.quotas must be an object`);
  const quotas = new Map();
  for (const [account, amount] of Object.entries(raw.quotas)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      fail(`${path}.quotas.${account} must be a non-negative finite number`);
    }
    quotas.set(account, amount);
  }
  return { id, domains: new Set(raw.domains), quotas };
}

function validateRequest(raw, index) {
  const path = `requests[${index}]`;
  if (!isPlainObject(raw)) fail(`${path} must be an object`);
  return {
    idempotencyKey: requireId(raw.idempotencyKey, `${path}.idempotencyKey`),
    transactionId: requireId(raw.transactionId, `${path}.transactionId`),
  };
}

function validateInput(input) {
  if (!isPlainObject(input)) fail('input must be an object');
  if (!Array.isArray(input.transactions)) fail('transactions must be an array');
  if (!Array.isArray(input.batches)) fail('batches must be an array');
  if (!Array.isArray(input.requests)) fail('requests must be an array');

  const transactions = new Map();
  input.transactions.forEach((raw, index) => {
    const tx = validateTransaction(raw, index);
    if (transactions.has(tx.id)) fail(`duplicate transaction id "${tx.id}"`);
    transactions.set(tx.id, tx);
  });

  const batches = input.batches.map(validateBatch);
  const batchIds = new Set();
  for (const batch of batches) {
    if (batchIds.has(batch.id)) fail(`duplicate batch id "${batch.id}"`);
    batchIds.add(batch.id);
  }
  batches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const requests = input.requests.map(validateRequest);

  return { transactions, batches, requests };
}

module.exports = { validateInput, ValidationError, STAGE_TYPES };
