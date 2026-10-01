'use strict';

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

function solve(input) {
  const {
    voucherNo = 'VOUCHER',
    entries = [],
    accountGroups = {},
    reviewers = [],
    periods = [],
    requestedPeriod,
    approvalLayers = [],
    revocations = [],
    budget = 1000,
  } = input;

  for (const entry of entries) {
    if (!Object.prototype.hasOwnProperty.call(accountGroups, entry.account)) {
      throw new InputError(`unknown account: ${entry.account}`);
    }
    if (entry.direction !== 'debit' && entry.direction !== 'credit') {
      throw new InputError(`unknown direction: ${entry.direction}`);
    }
  }
  const layerIds = new Set(approvalLayers.map((layer) => layer.id));
  for (const point of revocations) {
    if (!layerIds.has(point)) {
      throw new InputError(`revocation references unknown layer: ${point}`);
    }
  }

  const conflictCore = [];

  let debit = 0;
  let credit = 0;
  for (const entry of entries) {
    if (entry.direction === 'debit') debit += entry.amount;
    else credit += entry.amount;
  }
  if (debit !== credit) {
    conflictCore.push(`balance: debit ${debit} != credit ${credit}`);
  }

  const periodMap = new Map(periods.map((period) => [period.id, period]));
  const requested = periodMap.get(requestedPeriod);
  if (!requested) {
    throw new InputError(`unknown period: ${requestedPeriod}`);
  }
  let period = requestedPeriod;
  let rerouted = false;
  if (requested.status === 'closed') {
    const adjustment = requested.adjustmentPeriod
      ? periodMap.get(requested.adjustmentPeriod)
      : undefined;
    if (adjustment && adjustment.status === 'open') {
      period = adjustment.id;
      rerouted = true;
    } else {
      conflictCore.push(
        `period: ${requestedPeriod} closed without open adjustment period`,
      );
    }
  }

  const requiredGroups = [...new Set(entries.map((entry) => accountGroups[entry.account]))];
  const domains = approvalLayers.map((layer) =>
    reviewers
      .filter((reviewer) =>
        requiredGroups.every((group) => reviewer.groups.includes(group)),
      )
      .map((reviewer) => reviewer.id),
  );
  approvalLayers.forEach((layer, index) => {
    if (domains[index].length === 0) {
      conflictCore.push(
        `domain: layer ${layer.id} has no reviewer covering groups [${requiredGroups.join(', ')}]`,
      );
    }
  });

  if (conflictCore.length > 0) {
    return {
      voucherNo,
      status: 'UNSAT',
      requestedPeriod,
      period: null,
      rerouted: false,
      approvalTrail: [],
      occupied: [],
      released: [],
      conflictCore,
    };
  }

  const assignment = new Array(approvalLayers.length).fill(null);
  let remaining = budget;
  let budgetExhausted = false;

  function search(layerIndex) {
    if (layerIndex === approvalLayers.length) return true;
    for (const candidate of domains[layerIndex]) {
      if (assignment.includes(candidate)) continue;
      if (remaining <= 0) {
        budgetExhausted = true;
        return false;
      }
      remaining -= 1;
      assignment[layerIndex] = candidate;
      if (search(layerIndex + 1)) return true;
      assignment[layerIndex] = null;
      if (budgetExhausted) return false;
    }
    return false;
  }

  const found = search(0);

  if (!found && budgetExhausted) {
    return {
      voucherNo,
      status: 'PENDING',
      requestedPeriod,
      period,
      rerouted,
      pendingVoucher: {
        voucherNo,
        entries,
        period,
        partialAssignment: approvalLayers
          .map((layer, index) => ({ layer: layer.id, reviewer: assignment[index] }))
          .filter((slot) => slot.reviewer !== null),
      },
      approvalTrail: [],
      occupied: [],
      released: [],
      conflictCore: [`budget: search budget ${budget} exhausted before determination`],
    };
  }

  if (!found) {
    return {
      voucherNo,
      status: 'UNSAT',
      requestedPeriod,
      period,
      rerouted,
      approvalTrail: [],
      occupied: [],
      released: [],
      conflictCore: [
        `assignment: no feasible distinct reviewer assignment across ${approvalLayers.length} layer(s) (fully enumerated)`,
      ],
    };
  }

  const total = debit;
  const revokeSet = new Set(revocations);
  const approvalTrail = [];
  const occupied = [];
  const released = [];
  let rejected = false;

  approvalLayers.forEach((layer, index) => {
    const reviewer = assignment[index];
    if (rejected) {
      approvalTrail.push({
        layer: layer.id,
        reviewer,
        decision: 'released',
        reason: 'lower layer of a rejected layer',
      });
      released.push({ layer: layer.id, amount: total });
      return;
    }
    if (revokeSet.has(layer.id)) {
      rejected = true;
      approvalTrail.push({ layer: layer.id, reviewer, decision: 'rejected' });
      released.push({ layer: layer.id, amount: total });
      return;
    }
    approvalTrail.push({ layer: layer.id, reviewer, decision: 'approved' });
    occupied.push({ layer: layer.id, amount: total });
  });

  return {
    voucherNo,
    status: rejected ? 'REJECTED' : 'APPROVED',
    requestedPeriod,
    period,
    rerouted,
    assignment: approvalLayers.map((layer, index) => ({
      layer: layer.id,
      reviewer: assignment[index],
    })),
    approvalTrail,
    occupied,
    released,
    conflictCore: [],
  };
}

module.exports = { solve, InputError };
