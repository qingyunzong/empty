'use strict';

// Cancellation engine.
//
// Semantics:
// - A stage's dependsOn lists its child stages: children are always
//   compensated before their parents (reverse of the business flow
//   trade -> fee -> freeze -> settlement).
// - Each compensation is placed into exactly one batch whose domain allows
//   the stage kind. Within a single cancel request, the total compensated
//   amount per account per batch must not exceed the batch's recoverable
//   quota for that account (accounts missing from `recoverable` have quota 0).
// - Reconciled stages are compensated by a red-flush reversal entry; other
//   stages are compensated by a delete entry.
// - If the full compensation sequence cannot be placed, the longest feasible
//   prefix is applied (PARTIAL) and the remaining stages stay pending, so a
//   later request for the same transaction can resume them.
// - Idempotency keys replay the stored result without touching state.

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

// Deterministic topological order: children (dependsOn targets) first.
function compensationOrder(tx) {
  const remaining = new Map(tx.stages);
  const done = new Set();
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((stage) => stage.dependsOn.every((child) => done.has(child)))
      .map((stage) => stage.id)
      .sort();
    const nextId = ready[0];
    order.push(remaining.get(nextId));
    done.add(nextId);
    remaining.delete(nextId);
  }
  return order;
}

// Backtracking batch placement with infeasible-batch propagation
// (domain/quota pruning plus forward checking on remaining stages).
// Returns an array of batch ids parallel to `stages`, or null.
function assignBatches(stages, batches) {
  const usage = batches.map(() => new Map());
  const result = new Array(stages.length);

  const quotaOf = (batchIndex, account) => {
    const quota = batches[batchIndex].recoverable[account];
    return quota === undefined ? 0 : quota;
  };
  const fits = (batchIndex, stage) => {
    if (!batches[batchIndex].domains.has(stage.kind)) return false;
    const used = usage[batchIndex].get(stage.account) || 0;
    return used + stage.amount <= quotaOf(batchIndex, stage.account);
  };
  // Propagation: every remaining stage must still have at least one batch
  // that can accept it given the usage accumulated so far.
  const forwardOk = (from) => {
    for (let k = from; k < stages.length; k += 1) {
      let any = false;
      for (let i = 0; i < batches.length; i += 1) {
        if (fits(i, stages[k])) { any = true; break; }
      }
      if (!any) return false;
    }
    return true;
  };
  const dfs = (index) => {
    if (index === stages.length) return true;
    const stage = stages[index];
    for (let i = 0; i < batches.length; i += 1) {
      if (!fits(i, stage)) continue;
      usage[i].set(stage.account, (usage[i].get(stage.account) || 0) + stage.amount);
      result[index] = batches[i].id;
      if (forwardOk(index + 1) && dfs(index + 1)) return true;
      usage[i].set(stage.account, usage[i].get(stage.account) - stage.amount);
      result[index] = undefined;
    }
    return false;
  };
  return dfs(0) ? result : null;
}

// Longest placeable prefix of the ordered stages (prefix property makes this
// well defined: if a prefix of length k is placeable, so is any shorter one).
function solveSequence(stages, batches) {
  for (let k = stages.length; k >= 0; k -= 1) {
    const assignment = assignBatches(stages.slice(0, k), batches);
    if (assignment) return { prefix: k, assignment };
  }
  return { prefix: 0, assignment: [] };
}

// Path from the conflicting stage up to the root stage, following parents
// (stages that depend on it). Deterministic: smallest parent id first.
function buildConflictPath(tx, conflictStageId) {
  const parents = new Map([...tx.stages.keys()].map((id) => [id, []]));
  for (const stage of tx.stages.values()) {
    for (const child of stage.dependsOn) parents.get(child).push(stage.id);
  }
  const path = [conflictStageId];
  let current = conflictStageId;
  while (parents.get(current).length > 0) {
    current = [...parents.get(current)].sort()[0];
    path.push(current);
  }
  return path;
}

function createSession(input) {
  const transactions = new Map();
  for (const tx of input.transactions) {
    const stages = new Map();
    for (const stage of tx.stages) {
      stages.set(stage.id, {
        id: stage.id,
        kind: stage.kind,
        account: stage.account,
        amount: stage.amount,
        status: stage.status,
        dependsOn: [...stage.dependsOn],
      });
    }
    transactions.set(tx.id, { id: tx.id, stages, sequence: [], pending: [] });
  }
  const batches = input.batches.map((batch) => ({
    id: batch.id,
    domains: new Set(batch.domains),
    recoverable: { ...batch.recoverable },
  }));
  const idempotency = new Map();

  const applyCompensation = (tx, stage, batchId) => {
    const action = stage.status === 'reconciled' ? 'reversal' : 'delete';
    const entry = {
      stageId: stage.id,
      kind: stage.kind,
      account: stage.account,
      amount: stage.amount,
      batchId,
      action,
    };
    stage.status = 'compensated';
    tx.sequence.push(entry);
    return entry;
  };

  const executeRequest = (request) => {
    const tx = transactions.get(request.transactionId);
    if (!tx) {
      return {
        status: 'REJECTED',
        reason: 'TRANSACTION_NOT_FOUND',
        sequence: [],
        pending: [],
        conflictPath: null,
        compensated: [],
      };
    }
    const todo = compensationOrder(tx).filter((stage) => stage.status !== 'compensated');
    if (todo.length === 0) {
      return {
        status: 'REJECTED',
        reason: 'NOTHING_TO_CANCEL',
        sequence: [],
        pending: [],
        conflictPath: null,
        compensated: tx.sequence.map((entry) => entry.stageId),
      };
    }
    const { prefix, assignment } = solveSequence(todo, batches);
    const applied = [];
    for (let i = 0; i < prefix; i += 1) {
      applied.push(applyCompensation(tx, todo[i], assignment[i]));
    }
    const pendingStages = todo.slice(prefix);
    for (const stage of pendingStages) stage.status = 'pending';
    tx.pending = pendingStages.map((stage) => stage.id);
    const status = pendingStages.length === 0 ? 'COMPLETED' : 'PARTIAL';
    return {
      status,
      reason: null,
      sequence: applied,
      pending: [...tx.pending],
      conflictPath: pendingStages.length > 0 ? buildConflictPath(tx, pendingStages[0].id) : null,
      compensated: tx.sequence.map((entry) => entry.stageId),
    };
  };

  const processRequest = (request) => {
    const cached = idempotency.get(request.idempotencyKey);
    if (cached) {
      const replay = deepCopy(cached);
      replay.replayed = true;
      return replay;
    }
    const result = executeRequest(request);
    const record = {
      idempotencyKey: request.idempotencyKey,
      transactionId: request.transactionId,
      ...result,
    };
    idempotency.set(request.idempotencyKey, deepCopy(record));
    return { ...deepCopy(record), replayed: false };
  };

  const snapshot = () => ({
    transactions: [...transactions.values()].map((tx) => ({
      id: tx.id,
      compensated: tx.sequence.map((entry) => entry.stageId),
      pending: [...tx.pending],
      sequence: deepCopy(tx.sequence),
      stages: [...tx.stages.values()].map((stage) => ({ id: stage.id, status: stage.status })),
    })),
  });

  return { processRequest, snapshot };
}

function runAll(input) {
  const session = createSession(input);
  const results = input.requests.map((request) => session.processRequest(request));
  return { results, state: session.snapshot() };
}

module.exports = {
  createSession,
  runAll,
  compensationOrder,
  assignBatches,
  solveSequence,
  buildConflictPath,
};
