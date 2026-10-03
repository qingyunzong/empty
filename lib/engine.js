'use strict';

const { validateInput } = require('./validate');
const { solvePlacement } = require('./solver');

class CancellationEngine {
  constructor(input) {
    this.data = validateInput(input);
    this.remaining = new Map();
    for (const batch of this.data.batches) {
      this.remaining.set(batch.id, new Map(batch.quotas));
    }
    this.compensated = new Set();
    this.sequence = [];
    this.idempotency = new Map();
  }

  processAll() {
    const results = this.data.requests.map((request) => this.processRequest(request));
    const status =
      results.length === 0 || results.every((r) => r.status === 'COMPLETED')
        ? 'COMPLETED'
        : results.every((r) => r.status === 'REJECTED')
          ? 'REJECTED'
          : 'PARTIAL';
    return {
      status,
      results,
      state: {
        sequence: this.sequence.map((record, index) => ({ seq: index + 1, ...record })),
        remainingQuotas: this.remainingQuotas(),
        pending: this.pendingList(),
      },
    };
  }

  processRequest(request) {
    const cached = this.idempotency.get(request.idempotencyKey);
    if (cached) {
      return { ...structuredClone(cached), replayed: true };
    }
    const result = this.executeRequest(request);
    this.idempotency.set(request.idempotencyKey, structuredClone(result));
    return result;
  }

  executeRequest(request) {
    const base = {
      idempotencyKey: request.idempotencyKey,
      transactionId: request.transactionId,
      replayed: false,
    };
    const tx = this.data.transactions.get(request.transactionId);
    if (!tx) {
      return {
        ...base,
        status: 'REJECTED',
        reason: `unknown transaction "${request.transactionId}"`,
        sequence: [],
        pending: [],
        conflicts: [],
      };
    }

    const pendingStages = tx.order
      .map((stageId) => tx.stageById.get(stageId))
      .filter((stage) => !this.compensated.has(stage.id));

    if (pendingStages.length === 0) {
      return {
        ...base,
        status: 'COMPLETED',
        note: 'transaction already fully cancelled',
        sequence: [],
        pending: [],
        conflicts: [],
      };
    }

    const { placements } = solvePlacement(
      pendingStages,
      this.data.batches,
      this.remaining,
      this.compensated
    );

    const records = [];
    for (const stage of pendingStages) {
      const batchId = placements.get(stage.id);
      if (batchId === undefined) continue;
      const accountQuota = this.remaining.get(batchId);
      accountQuota.set(stage.account, (accountQuota.get(stage.account) || 0) - stage.amount);
      const record = {
        transactionId: tx.id,
        stageId: stage.id,
        type: stage.type,
        account: stage.account,
        amount: stage.amount,
        batchId,
        mode: stage.status === 'reconciled' ? 'reversal' : 'delete',
      };
      this.sequence.push(record);
      records.push(record);
      this.compensated.add(stage.id);
    }

    const unplaced = pendingStages.filter((stage) => !placements.has(stage.id));
    const conflicts = this.buildConflicts(tx, unplaced, placements);
    const pending = unplaced.map((stage) => ({
      transactionId: tx.id,
      stageId: stage.id,
      type: stage.type,
      account: stage.account,
      amount: stage.amount,
      recoverable: true,
    }));

    const status =
      unplaced.length === 0 ? 'COMPLETED' : records.length > 0 ? 'PARTIAL' : 'REJECTED';
    return { ...base, status, sequence: records, pending, conflicts };
  }

  // Root-cause conflicts: unplaced stages whose children are all compensated or
  // placed. The path walks up unplaced parents to show how the conflict
  // propagates through the stage dependency chain.
  buildConflicts(tx, unplaced, placements) {
    const unplacedIds = new Set(unplaced.map((stage) => stage.id));
    const placedOrDone = (stageId) =>
      this.compensated.has(stageId) || placements.has(stageId);
    const conflicts = [];
    for (const stage of unplaced) {
      const blockedByChild = stage.children.some(
        (childId) => !placedOrDone(childId)
      );
      if (blockedByChild) continue;
      const domainBatches = this.data.batches.filter((batch) =>
        batch.domains.has(stage.type)
      );
      const reason =
        domainBatches.length === 0 ? 'NO_DOMAIN_BATCH' : 'INSUFFICIENT_QUOTA';
      const infeasibleBatches = domainBatches.map((batch) => ({
        batchId: batch.id,
        account: stage.account,
        remaining: this.remaining.get(batch.id).get(stage.account) || 0,
        required: stage.amount,
      }));
      const path = [stage.id];
      const seen = new Set(path);
      let current = stage;
      while (true) {
        const parentId = current.dependsOn.find(
          (id) => unplacedIds.has(id) && !seen.has(id)
        );
        if (parentId === undefined) break;
        path.push(parentId);
        seen.add(parentId);
        current = tx.stageById.get(parentId);
      }
      conflicts.push({
        transactionId: tx.id,
        stageId: stage.id,
        type: stage.type,
        account: stage.account,
        amount: stage.amount,
        reason,
        infeasibleBatches,
        path,
      });
    }
    return conflicts;
  }

  remainingQuotas() {
    const quotas = {};
    for (const batch of this.data.batches) {
      quotas[batch.id] = Object.fromEntries(this.remaining.get(batch.id));
    }
    return quotas;
  }

  pendingList() {
    const pending = [];
    for (const tx of this.data.transactions.values()) {
      for (const stageId of tx.order) {
        if (this.compensated.has(stageId)) continue;
        const stage = tx.stageById.get(stageId);
        pending.push({
          transactionId: tx.id,
          stageId: stage.id,
          type: stage.type,
          account: stage.account,
          amount: stage.amount,
          recoverable: true,
        });
      }
    }
    return pending;
  }
}

module.exports = { CancellationEngine };
