'use strict';

const EPS = 1e-9;
const DISPOSITIONS = ['FULL', 'NET', 'SUSPEND'];

// Available limit per account: limit minus prior freezes that were not released
// by a revocation.
function availableLimits(valid) {
  const available = new Map();
  for (const [id, account] of valid.accounts) {
    available.set(id, account.limit);
  }
  for (const instruction of valid.instructions) {
    if (valid.revoked.has(instruction.id)) continue; // released by revocation
    available.set(instruction.from, available.get(instruction.from) - instruction.frozen);
  }
  return available;
}

// Total new freeze per account for a complete plan (id -> disposition).
function computeFreezes(valid, plan) {
  const lookup = (id) => (plan instanceof Map ? plan.get(id) : plan[id]);
  const totals = new Map([...valid.accounts.keys()].map((id) => [id, 0]));
  const directions = new Map();
  for (const instruction of valid.instructions) {
    const disposition = lookup(instruction.id);
    if (disposition === 'FULL') {
      totals.set(instruction.from, totals.get(instruction.from) + instruction.amount);
    } else if (disposition === 'NET') {
      const key = `${instruction.from}→${instruction.to}`;
      directions.set(key, {
        from: instruction.from,
        oppositeKey: `${instruction.to}→${instruction.from}`,
        amount: (directions.get(key) ? directions.get(key).amount : 0) + instruction.amount,
      });
    }
  }
  for (const [key, direction] of directions) {
    const opposite = directions.get(direction.oppositeKey);
    const netted = Math.max(0, direction.amount - (opposite ? opposite.amount : 0));
    totals.set(direction.from, totals.get(direction.from) + netted);
  }
  return totals;
}

// Structural validity of a complete plan, independent of the solver.
function planValid(valid, plan) {
  const lookup = (id) => (plan instanceof Map ? plan.get(id) : plan[id]);
  for (const instruction of valid.instructions) {
    const disposition = lookup(instruction.id);
    if (!DISPOSITIONS.includes(disposition)) return false;
    if (valid.revoked.has(instruction.id) && disposition !== 'SUSPEND') return false;
    if (disposition === 'NET') {
      const hasCounterpart = valid.instructions.some(
        (other) =>
          other.id !== instruction.id &&
          other.from === instruction.to &&
          other.to === instruction.from &&
          lookup(other.id) === 'NET',
      );
      if (!hasCounterpart) return false;
    }
  }
  const available = availableLimits(valid);
  const totals = computeFreezes(valid, plan);
  for (const [id, total] of totals) {
    if (total > available.get(id) + EPS) return false;
  }
  return true;
}

// Brute-force enumeration of every disposition combination (used by tests).
function enumerateValidPlans(valid) {
  const variables = valid.instructions.filter((instruction) => !valid.revoked.has(instruction.id));
  const plans = [];
  const current = new Map();
  for (const instruction of valid.instructions) {
    if (valid.revoked.has(instruction.id)) current.set(instruction.id, 'SUSPEND');
  }
  const visit = (index) => {
    if (index === variables.length) {
      if (planValid(valid, current)) plans.push(new Map(current));
      return;
    }
    for (const disposition of DISPOSITIONS) {
      current.set(variables[index].id, disposition);
      visit(index + 1);
    }
  };
  visit(0);
  return plans;
}

function buildContext(valid) {
  const available = availableLimits(valid);
  const variables = valid.instructions.filter((instruction) => !valid.revoked.has(instruction.id));
  const opposite = variables.map((instruction) =>
    variables
      .map((other, index) => ({ other, index }))
      .filter(({ other }) => other.from === instruction.to && other.to === instruction.from)
      .map(({ index }) => index),
  );
  const directionOf = [];
  const directions = new Map();
  variables.forEach((instruction, index) => {
    const key = `${instruction.from}→${instruction.to}`;
    const oppositeKey = `${instruction.to}→${instruction.from}`;
    if (!directions.has(key)) {
      directions.set(key, { from: instruction.from, indices: [], oppositeKey });
    }
    directions.get(key).indices.push(index);
    directionOf.push(key);
  });
  return { valid, available, variables, opposite, directions, directionOf, budget: valid.budget };
}

// Lower bound of the freeze per account given current assignments and domains.
function lowerBounds(ctx, assigned, domains) {
  const lb = new Map([...ctx.available.keys()].map((id) => [id, 0]));
  ctx.variables.forEach((instruction, index) => {
    if (assigned[index] === 'FULL') {
      lb.set(instruction.from, lb.get(instruction.from) + instruction.amount);
    }
  });
  for (const direction of ctx.directions.values()) {
    let netMin = 0;
    for (const index of direction.indices) {
      if (assigned[index] === 'NET') netMin += ctx.variables[index].amount;
    }
    const oppositeDirection = ctx.directions.get(direction.oppositeKey);
    let oppositeMax = 0;
    if (oppositeDirection) {
      for (const index of oppositeDirection.indices) {
        const possible = assigned[index] === 'NET' || (assigned[index] === null && domains[index].has('NET'));
        if (possible) oppositeMax += ctx.variables[index].amount;
      }
    }
    lb.set(direction.from, lb.get(direction.from) + Math.max(0, netMin - oppositeMax));
  }
  return lb;
}

function netDelta(ctx, assigned, domains, index) {
  const direction = ctx.directions.get(ctx.directionOf[index]);
  const oppositeDirection = ctx.directions.get(direction.oppositeKey);
  let netMin = 0;
  for (const other of direction.indices) {
    if (assigned[other] === 'NET') netMin += ctx.variables[other].amount;
  }
  let oppositeMax = 0;
  if (oppositeDirection) {
    for (const other of oppositeDirection.indices) {
      const possible = assigned[other] === 'NET' || (assigned[other] === null && domains[other].has('NET'));
      if (possible) oppositeMax += ctx.variables[other].amount;
    }
  }
  const amount = ctx.variables[index].amount;
  return Math.max(0, netMin + amount - oppositeMax) - Math.max(0, netMin - oppositeMax);
}

// Finite-domain propagation. Returns null on success or a conflict object.
function propagate(ctx, assigned, domains) {
  let changed = true;
  while (changed) {
    changed = false;
    // Netting requires a bidirectional counterpart that can also net.
    for (let index = 0; index < ctx.variables.length; index += 1) {
      const netAssigned = assigned[index] === 'NET';
      const netPossible = netAssigned || (assigned[index] === null && domains[index].has('NET'));
      if (!netPossible) continue;
      const supported = ctx.opposite[index].some(
        (other) => assigned[other] === 'NET' || (assigned[other] === null && domains[other].has('NET')),
      );
      if (supported) continue;
      if (netAssigned) {
        return { reason: 'net-support', instruction: ctx.variables[index].id };
      }
      domains[index].delete('NET');
      changed = true;
      if (domains[index].size === 0) {
        return { reason: 'domain-empty', instruction: ctx.variables[index].id };
      }
    }
    const lb = lowerBounds(ctx, assigned, domains);
    for (const [id, bound] of lb) {
      if (bound > ctx.available.get(id) + EPS) {
        return { reason: 'limit-exceeded', account: id };
      }
    }
    // Value pruning against account limits.
    for (let index = 0; index < ctx.variables.length; index += 1) {
      if (assigned[index] !== null) continue;
      const instruction = ctx.variables[index];
      const limit = ctx.available.get(instruction.from);
      if (domains[index].has('FULL') && lb.get(instruction.from) + instruction.amount > limit + EPS) {
        domains[index].delete('FULL');
        changed = true;
      }
      if (
        domains[index].has('NET') &&
        lb.get(instruction.from) + netDelta(ctx, assigned, domains, index) > limit + EPS
      ) {
        domains[index].delete('NET');
        changed = true;
      }
      if (domains[index].size === 0) {
        return { reason: 'domain-empty', instruction: instruction.id };
      }
    }
  }
  return null;
}

function solve(valid) {
  const ctx = buildContext(valid);
  const count = ctx.variables.length;
  const assigned = new Array(count).fill(null);
  let domains = ctx.variables.map(() => new Set(DISPOSITIONS));
  const decisions = [];
  let backtracks = 0;
  let budgetExhausted = false;
  let lastConflict = null;
  let solution = null;
  let finalDomains = null;

  const snapshotAssignments = () => {
    const list = [];
    for (let index = 0; index < count; index += 1) {
      if (assigned[index] !== null) {
        list.push({ instruction: ctx.variables[index].id, value: assigned[index] });
      }
    }
    return list;
  };

  const pickVariable = () => {
    let best = -1;
    for (let index = 0; index < count; index += 1) {
      if (assigned[index] !== null) continue;
      if (best === -1 || domains[index].size < domains[best].size) best = index;
    }
    return best;
  };

  const search = () => {
    const conflict = propagate(ctx, assigned, domains);
    if (conflict) {
      lastConflict = { ...conflict, assignments: snapshotAssignments() };
      return 'conflict';
    }
    const variable = pickVariable();
    if (variable === -1) {
      solution = assigned.slice();
      finalDomains = domains.map((domain) => [...domain]);
      return 'solution';
    }
    for (const value of DISPOSITIONS) {
      if (!domains[variable].has(value)) continue;
      const savedDomains = domains.map((domain) => new Set(domain));
      assigned[variable] = value;
      decisions.push({ instruction: ctx.variables[variable].id, value, undone: false });
      const result = search();
      if (result === 'solution') return 'solution';
      assigned[variable] = null;
      domains = savedDomains;
      decisions[decisions.length - 1].undone = true;
      if (result === 'budget') return 'budget';
      backtracks += 1;
      if (backtracks > ctx.budget) {
        budgetExhausted = true;
        finalDomains = domains.map((domain) => [...domain]);
        return 'budget';
      }
    }
    return 'conflict';
  };

  search();

  const status = solution ? 'SAT' : budgetExhausted ? 'PENDING' : 'UNSAT';
  if (!solution && !finalDomains) {
    finalDomains = domains.map((domain) => [...domain]);
  }

  const plan = {};
  for (const instruction of valid.instructions) {
    plan[instruction.id] = valid.revoked.has(instruction.id) ? 'SUSPEND' : null;
  }
  if (solution) {
    ctx.variables.forEach((instruction, index) => {
      plan[instruction.id] = solution[index];
    });
  }

  const freezeTotals = {};
  for (const id of valid.accounts.keys()) freezeTotals[id] = 0;
  if (solution) {
    const totals = computeFreezes(valid, plan);
    for (const [id, total] of totals) freezeTotals[id] = total;
  }

  const minConflictSet = lastConflict ? minimizeConflict(ctx, lastConflict.assignments) : [];

  const domainsOut = {};
  ctx.variables.forEach((instruction, index) => {
    domainsOut[instruction.id] = DISPOSITIONS.filter((value) => finalDomains[index].includes(value));
  });
  for (const instruction of valid.instructions) {
    if (valid.revoked.has(instruction.id)) domainsOut[instruction.id] = ['SUSPEND'];
  }

  const suspended = [];
  for (const instruction of valid.instructions) {
    const disposition = plan[instruction.id];
    if (disposition === 'SUSPEND' || (disposition === null && valid.revoked.has(instruction.id))) {
      suspended.push({ id: instruction.id, reasons: suspendReasons(valid, ctx, instruction) });
    }
  }

  return {
    status,
    plan: solution ? plan : null,
    suspended,
    freezeTotals,
    certificate: {
      decisions,
      domains: domainsOut,
      freezeTotals,
      revocationOrder: valid.revocationOrder,
      backtracks,
      minConflictSet,
    },
  };
}

function conflictsWith(ctx, assignments) {
  const assigned = new Array(ctx.variables.length).fill(null);
  const domains = ctx.variables.map(() => new Set(DISPOSITIONS));
  const indexOf = new Map(ctx.variables.map((instruction, index) => [instruction.id, index]));
  for (const { instruction, value } of assignments) {
    const index = indexOf.get(instruction);
    if (index === undefined) return false;
    assigned[index] = value;
  }
  return propagate(ctx, assigned, domains) !== null;
}

// Greedy minimization: drop every assignment that is not required to keep the conflict.
function minimizeConflict(ctx, assignments) {
  let current = assignments.slice();
  let reduced = true;
  while (reduced) {
    reduced = false;
    for (let index = 0; index < current.length; index += 1) {
      const trial = current.filter((_, other) => other !== index);
      if (conflictsWith(ctx, trial)) {
        current = trial;
        reduced = true;
        break;
      }
    }
  }
  return current;
}

function suspendReasons(valid, ctx, instruction) {
  const reasons = [];
  if (valid.revoked.has(instruction.id)) {
    reasons.push('revoked');
    return reasons;
  }
  const hasCounterpart = valid.instructions.some(
    (other) =>
      other.id !== instruction.id &&
      other.from === instruction.to &&
      other.to === instruction.from &&
      !valid.revoked.has(other.id),
  );
  if (!hasCounterpart) reasons.push('no_bidirectional_counterpart');
  if (instruction.amount > ctx.available.get(instruction.from) + EPS) {
    reasons.push('insufficient_limit');
  }
  if (reasons.length === 0) reasons.push('limit_contention');
  return reasons;
}

module.exports = {
  DISPOSITIONS,
  solve,
  computeFreezes,
  planValid,
  enumerateValidPlans,
  availableLimits,
};
