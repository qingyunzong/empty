'use strict';

const KINDS = new Set(['trade', 'fee', 'freeze', 'settlement']);
const STAGE_STATUSES = new Set(['posted', 'reconciled']);

class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateStage(txId, stage) {
  const where = `transaction ${txId}`;
  if (!isPlainObject(stage)) fail(`${where}: stage must be an object`);
  if (!isNonEmptyString(stage.id)) fail(`${where}: stage.id must be a non-empty string`);
  if (!KINDS.has(stage.kind)) {
    fail(`${where} stage ${stage.id}: kind must be one of ${[...KINDS].join(', ')}`);
  }
  if (!isNonEmptyString(stage.account)) {
    fail(`${where} stage ${stage.id}: account must be a non-empty string`);
  }
  if (typeof stage.amount !== 'number' || !Number.isFinite(stage.amount) || stage.amount <= 0) {
    fail(`${where} stage ${stage.id}: amount must be a positive finite number`);
  }
  if (!STAGE_STATUSES.has(stage.status)) {
    fail(`${where} stage ${stage.id}: status must be one of ${[...STAGE_STATUSES].join(', ')}`);
  }
  if (!Array.isArray(stage.dependsOn)) {
    fail(`${where} stage ${stage.id}: dependsOn must be an array`);
  }
  for (const dep of stage.dependsOn) {
    if (!isNonEmptyString(dep)) {
      fail(`${where} stage ${stage.id}: dependsOn entries must be non-empty strings`);
    }
  }
  if (new Set(stage.dependsOn).size !== stage.dependsOn.length) {
    fail(`${where} stage ${stage.id}: dependsOn contains duplicates`);
  }
}

function validateTransaction(tx) {
  if (!isPlainObject(tx)) fail('transaction must be an object');
  if (!isNonEmptyString(tx.id)) fail('transaction.id must be a non-empty string');
  if (!Array.isArray(tx.stages) || tx.stages.length === 0) {
    fail(`transaction ${tx.id}: stages must be a non-empty array`);
  }
  if (tx.stages.length > 4) {
    fail(`transaction ${tx.id}: at most 4 stages are supported`);
  }
  const stageIds = new Set();
  for (const stage of tx.stages) {
    validateStage(tx.id, stage);
    if (stageIds.has(stage.id)) {
      fail(`transaction ${tx.id}: duplicate stage id ${stage.id}`);
    }
    stageIds.add(stage.id);
  }
  for (const stage of tx.stages) {
    for (const dep of stage.dependsOn) {
      if (dep === stage.id) {
        fail(`transaction ${tx.id} stage ${stage.id}: self dependency`);
      }
      if (!stageIds.has(dep)) {
        fail(`transaction ${tx.id} stage ${stage.id}: unknown dependsOn stage ${dep}`);
      }
    }
  }
  // Cycle detection over dependsOn edges.
  const color = new Map(tx.stages.map((s) => [s.id, 0]));
  const adjacency = new Map(tx.stages.map((s) => [s.id, s.dependsOn]));
  const visit = (node) => {
    color.set(node, 1);
    for (const next of adjacency.get(node)) {
      if (color.get(next) === 1) {
        fail(`transaction ${tx.id}: dependency cycle detected at stage ${next}`);
      }
      if (color.get(next) === 0) visit(next);
    }
    color.set(node, 2);
  };
  for (const stage of tx.stages) {
    if (color.get(stage.id) === 0) visit(stage.id);
  }
}

function validateBatch(batch) {
  if (!isPlainObject(batch)) fail('batch must be an object');
  if (!isNonEmptyString(batch.id)) fail('batch.id must be a non-empty string');
  if (!Array.isArray(batch.domains) || batch.domains.length === 0) {
    fail(`batch ${batch.id}: domains must be a non-empty array`);
  }
  for (const domain of batch.domains) {
    if (!KINDS.has(domain)) fail(`batch ${batch.id}: unknown domain ${domain}`);
  }
  if (new Set(batch.domains).size !== batch.domains.length) {
    fail(`batch ${batch.id}: duplicate domains`);
  }
  if (!isPlainObject(batch.recoverable)) {
    fail(`batch ${batch.id}: recoverable must be an object mapping account to quota`);
  }
  for (const [account, quota] of Object.entries(batch.recoverable)) {
    if (account.length === 0) fail(`batch ${batch.id}: recoverable account must be non-empty`);
    if (typeof quota !== 'number' || !Number.isFinite(quota) || quota < 0) {
      fail(`batch ${batch.id}: recoverable quota for ${account} must be a non-negative finite number`);
    }
  }
}

function validateRequest(request) {
  if (!isPlainObject(request)) fail('request must be an object');
  if (!isNonEmptyString(request.idempotencyKey)) {
    fail('request.idempotencyKey must be a non-empty string');
  }
  if (!isNonEmptyString(request.transactionId)) {
    fail('request.transactionId must be a non-empty string');
  }
}

function validateInput(input) {
  if (!isPlainObject(input)) fail('input must be a JSON object');
  const { transactions, batches, requests } = input;
  if (!Array.isArray(transactions)) fail('transactions must be an array');
  if (!Array.isArray(batches)) fail('batches must be an array');
  if (!Array.isArray(requests)) fail('requests must be an array');

  const txIds = new Set();
  for (const tx of transactions) {
    validateTransaction(tx);
    if (txIds.has(tx.id)) fail(`duplicate transaction id: ${tx.id}`);
    txIds.add(tx.id);
  }
  const batchIds = new Set();
  for (const batch of batches) {
    validateBatch(batch);
    if (batchIds.has(batch.id)) fail(`duplicate batch id: ${batch.id}`);
    batchIds.add(batch.id);
  }
  for (const request of requests) validateRequest(request);
}

module.exports = { validateInput, ValidationError, KINDS, STAGE_STATUSES };
