'use strict';

const { enumerateAssignments } = require('./enumerate');

class InputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

function validate(input) {
  if (!input || typeof input !== 'object') {
    throw new InputError('BAD_INPUT', 'input must be a JSON object');
  }
  const accounts = input.accounts || {};
  for (const entry of input.entries || []) {
    if (!Object.prototype.hasOwnProperty.call(accounts, entry.account)) {
      throw new InputError('UNKNOWN_ACCOUNT', `unknown account: ${entry.account}`);
    }
  }
  const layerIds = new Set((input.layers || []).map((l) => l.id));
  for (const rev of input.revocations || []) {
    if (!layerIds.has(rev.layer)) {
      throw new InputError('UNKNOWN_LAYER', `revocation targets unknown layer: ${rev.layer}`);
    }
  }
}

function totals(entries) {
  let debit = 0;
  let credit = 0;
  for (const e of entries) {
    if (e.direction === 'debit') debit += e.amount;
    else credit += e.amount;
  }
  return { debit, credit };
}

// Domain propagation: reviewer r may take entry e only when the entry's
// account group is inside r.groups, and r has enough remaining capacity.
function propagateDomains(entries, accounts, reviewers) {
  return entries.map((e) => {
    const group = accounts[e.account].group;
    return reviewers
      .filter((r) => r.groups.includes(group) && (r.capacity == null || r.capacity >= e.amount))
      .map((r) => r.id);
  });
}

// DFS over reviewer assignments with capacity pruning.
// Returns { status: 'solved', assignment } | { status: 'unsat', explored } |
//         { status: 'pending', explored, pending }
function search(entries, domains, reviewers, budget) {
  const capacity = new Map(reviewers.map((r) => [r.id, r.capacity == null ? Infinity : r.capacity]));
  const load = new Map(reviewers.map((r) => [r.id, 0]));
  const assignment = new Array(entries.length).fill(null);
  let explored = 0;

  function dfs(i) {
    if (i === entries.length) return true;
    for (const rid of domains[i]) {
      explored += 1;
      if (explored > budget) return 'budget';
      if (load.get(rid) + entries[i].amount > capacity.get(rid)) continue;
      load.set(rid, load.get(rid) + entries[i].amount);
      assignment[i] = rid;
      const r = dfs(i + 1);
      if (r === true) return true;
      if (r === 'budget') return 'budget';
      load.set(rid, load.get(rid) - entries[i].amount);
      assignment[i] = null;
    }
    return false;
  }

  const r = dfs(0);
  if (r === true) return { status: 'solved', assignment, explored };
  if (r === 'budget') {
    return {
      status: 'pending',
      explored,
      pending: entries.map((e, i) => ({
        entry: e.id,
        assigned: assignment[i],
        remainingDomain: assignment[i] ? [] : domains[i],
      })),
    };
  }
  return { status: 'unsat', explored };
}

function routePeriod(input, conflictCore) {
  const periods = new Map((input.periods || []).map((p) => [p.id, p.status]));
  const original = input.originalPeriod;
  if (periods.get(original) !== 'closed') {
    return { period: original, rerouted: false };
  }
  const adj = input.adjustmentPeriod;
  if (periods.get(adj) === 'closed') {
    conflictCore.push(
      `period ${original} is closed and adjustment period ${adj} is also closed: no open posting period`,
    );
    return null;
  }
  return { period: adj, rerouted: true };
}

function simulateLayers(layers, revocations, total) {
  const rejectAt = new Set((revocations || []).map((r) => r.layer));
  const trail = [];
  let occupied = 0;
  let released = 0;
  let rejectedSeen = false;
  for (const layer of layers) {
    if (rejectedSeen) {
      trail.push({ layer: layer.id, status: 'released', released: total });
      released += total;
    } else if (rejectAt.has(layer.id)) {
      trail.push({ layer: layer.id, status: 'rejected' });
      rejectedSeen = true;
    } else {
      trail.push({ layer: layer.id, status: 'approved', occupied: total });
      occupied += total;
    }
  }
  return { trail, occupied, released };
}

function solve(input) {
  validate(input);

  const entries = (input.entries || []).map((e, i) => ({ id: e.id || `E${i + 1}`, ...e }));
  const accounts = input.accounts || {};
  const reviewers = input.reviewers || [];
  const layers = input.layers || [];
  const budget = input.budget == null ? Infinity : input.budget;
  const conflictCore = [];

  const sums = totals(entries);
  if (sums.debit !== sums.credit) {
    conflictCore.push(`unbalanced voucher: debit ${sums.debit} != credit ${sums.credit}`);
  }

  const domains = propagateDomains(entries, accounts, reviewers);
  entries.forEach((e, i) => {
    if (domains[i].length === 0) {
      conflictCore.push(
        `entry ${e.id}: no reviewer authorized for account group "${accounts[e.account].group}"`,
      );
    }
  });

  const routing = routePeriod(input, conflictCore);

  if (conflictCore.length > 0) {
    const proof = enumerateAssignments(entries, domains, reviewers);
    // Balance and period-routing conflicts are assignment-independent, so no
    // reviewer assignment can rescue the voucher: enumeration proves UNSAT.
    const assignmentIndependent = sums.debit !== sums.credit || routing === null;
    return {
      status: 'UNSAT',
      voucher: null,
      trail: [],
      occupied: 0,
      released: 0,
      conflictCore,
      proof: {
        enumerated: proof.explored,
        solutions: assignmentIndependent ? 0 : proof.solutions,
      },
    };
  }

  const found = search(entries, domains, reviewers, budget);

  if (found.status === 'pending') {
    return {
      status: 'PENDING',
      voucher: null,
      trail: [],
      occupied: 0,
      released: 0,
      conflictCore: [],
      budget,
      explored: found.explored,
      pending: found.pending.filter((p) => !p.assigned),
    };
  }

  if (found.status === 'unsat') {
    const proof = enumerateAssignments(entries, domains, reviewers);
    return {
      status: 'UNSAT',
      voucher: null,
      trail: [],
      occupied: 0,
      released: 0,
      conflictCore: ['no reviewer assignment satisfies permission domains and capacities'],
      proof: { enumerated: proof.explored, solutions: proof.solutions },
    };
  }

  const total = Math.max(sums.debit, sums.credit);
  const { trail, occupied, released } = simulateLayers(layers, input.revocations, total);

  return {
    status: 'SOLVED',
    voucher: {
      id: `ADJ-${routing.period}-001`,
      period: routing.period,
      rerouted: routing.rerouted,
      entries: entries.map((e, i) => ({
        id: e.id,
        account: e.account,
        direction: e.direction,
        amount: e.amount,
        reviewer: found.assignment[i],
      })),
      debitTotal: sums.debit,
      creditTotal: sums.credit,
    },
    trail,
    occupied,
    released,
    conflictCore: [],
    explored: found.explored,
  };
}

module.exports = { solve, InputError };
