'use strict';

const TIERS = [
  { name: 'FULL', ratio: 1 },
  { name: 'EIGHTY', ratio: 0.8 },
  { name: 'DEFERRED', ratio: 0 },
];

function occupancyCents(expense, tierIndex) {
  const tierCents = Math.round(expense.amountCents * TIERS[tierIndex].ratio);
  return Math.max(expense.paidCents, tierCents);
}

function solve(envelopes, expenses, backtrackBudget) {
  const vars = expenses.map((expense, index) => ({ expense, index }));
  const usedCents = new Map(envelopes.map((env) => [env.id, 0]));
  const assignment = new Array(vars.length).fill(null);
  const conflicts = [];
  const seenConflicts = new Set();
  let nodes = 0;
  let backtracks = 0;
  let aborted = false;

  function buildDomains() {
    const groupEnvelope = new Map();
    for (let i = 0; i < vars.length; i++) {
      const current = assignment[i];
      const group = vars[i].expense.group;
      if (current && group) {
        const prev = groupEnvelope.get(group);
        if (prev && prev !== current.envelopeId) return null;
        groupEnvelope.set(group, current.envelopeId);
      }
    }
    const domains = new Array(vars.length).fill(null);
    for (let i = 0; i < vars.length; i++) {
      if (assignment[i]) continue;
      const expense = vars[i].expense;
      const forced = expense.group ? groupEnvelope.get(expense.group) : undefined;
      const domain = [];
      for (let tierIndex = 0; tierIndex < TIERS.length; tierIndex++) {
        const occ = occupancyCents(expense, tierIndex);
        for (const env of envelopes) {
          if (env.category !== expense.category) continue;
          if (forced && env.id !== forced) continue;
          if (usedCents.get(env.id) + occ > env.limitCents) continue;
          domain.push({ envelopeId: env.id, tierIndex });
        }
      }
      domains[i] = domain;
    }
    return domains;
  }

  function recordConflict(varIndex) {
    const expense = vars[varIndex].expense;
    const candidates = envelopes.filter((env) => env.category === expense.category);
    const blockers = [];
    for (let i = 0; i < vars.length; i++) {
      const current = assignment[i];
      if (current && candidates.some((env) => env.id === current.envelopeId)) {
        blockers.push(vars[i].expense.id);
      }
    }
    const key = expense.id + '|' + blockers.slice().sort().join(',');
    if (seenConflicts.has(key)) return;
    seenConflicts.add(key);
    conflicts.push({
      expenseId: expense.id,
      category: expense.category,
      reason: candidates.length === 0
        ? 'no envelope matches the expense category'
        : 'every envelope/tier combination exceeds the envelope limit',
      envelopes: candidates.map((env) => ({
        id: env.id,
        limit: env.limitCents / 100,
        used: usedCents.get(env.id) / 100,
      })),
      blockers,
    });
  }

  function search() {
    if (aborted) return false;
    const domains = buildDomains();
    if (domains === null) return false;
    let chosen = -1;
    for (let i = 0; i < vars.length; i++) {
      if (assignment[i]) continue;
      if (domains[i].length === 0) {
        recordConflict(i);
        return false;
      }
      if (chosen === -1 || domains[i].length < domains[chosen].length) chosen = i;
    }
    if (chosen === -1) return true;
    nodes++;
    for (const value of domains[chosen]) {
      const occ = occupancyCents(vars[chosen].expense, value.tierIndex);
      assignment[chosen] = value;
      usedCents.set(value.envelopeId, usedCents.get(value.envelopeId) + occ);
      if (search()) return true;
      usedCents.set(value.envelopeId, usedCents.get(value.envelopeId) - occ);
      assignment[chosen] = null;
      backtracks++;
      if (backtracks > backtrackBudget) {
        aborted = true;
        return false;
      }
    }
    return false;
  }

  const found = search();
  const status = found ? 'OK' : aborted ? 'PENDING' : 'UNSAT';
  const assignments = [];
  if (found) {
    for (let i = 0; i < vars.length; i++) {
      const value = assignment[i];
      assignments.push({
        expenseId: vars[i].expense.id,
        envelopeId: value.envelopeId,
        tier: TIERS[value.tierIndex].name,
        reserved: occupancyCents(vars[i].expense, value.tierIndex) / 100,
      });
    }
  }
  return {
    status,
    assignments,
    conflicts,
    stats: { nodes, backtracks, backtrackBudget },
  };
}

module.exports = { solve, TIERS, occupancyCents };
