'use strict';

const FULL = 'FULL';
const NET = 'NET';
const PEND = 'PEND';
const VALUE_ORDER = [FULL, NET, PEND];
const EPS = 1e-9;

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function fmt(value) {
  return String(round6(value));
}

// Freeze semantics:
// - FULL instruction freezes its full amount on the payer account.
// - NET instructions between an ordered pair of accounts are netted:
//   account a freezes max(0, out(a->b) - out(b->a)) per counterparty b.
// - PEND freezes nothing.
function computeFreezes(accounts, instructions, assignment) {
  const freezes = new Map(accounts.map((account) => [account.id, 0]));
  const netOut = new Map();
  instructions.forEach((instruction, i) => {
    const disposition = assignment[i];
    if (disposition === FULL) {
      freezes.set(instruction.from, freezes.get(instruction.from) + instruction.amount);
    } else if (disposition === NET) {
      if (!netOut.has(instruction.from)) netOut.set(instruction.from, new Map());
      const row = netOut.get(instruction.from);
      row.set(instruction.to, (row.get(instruction.to) || 0) + instruction.amount);
    }
  });
  for (const [from, row] of netOut) {
    for (const [to, out] of row) {
      const reverseRow = netOut.get(to);
      const back = (reverseRow && reverseRow.get(from)) || 0;
      freezes.set(from, freezes.get(from) + Math.max(0, out - back));
    }
  }
  return freezes;
}

function solve(problem) {
  const { accounts, instructions, revocations, budget, previous } = problem;
  const n = instructions.length;
  const revokedSeq = new Map(revocations.map((r) => [r.instruction, r.seq]));
  const limitOf = new Map(accounts.map((a) => [a.id, a.limit]));

  const reverseOf = instructions.map((instruction) => {
    const partners = [];
    instructions.forEach((other, j) => {
      if (other.from === instruction.to && other.to === instruction.from) partners.push(j);
    });
    return partners;
  });

  // Sound lower bound of the freeze on an account given current domains.
  // Forced FULL instructions contribute their amount; each forced-NET pair of
  // accounts contributes max(0, forcedOut - possibleIn). Also returns the
  // contributing items so conflicts can be explained.
  function accountLowerBound(accountId, domains) {
    let total = 0;
    const items = [];
    for (let i = 0; i < n; i += 1) {
      if (
        instructions[i].from === accountId &&
        domains[i].size === 1 &&
        domains[i].has(FULL)
      ) {
        total += instructions[i].amount;
        items.push({ ids: [instructions[i].id], c: instructions[i].amount });
      }
    }
    for (const account of accounts) {
      const other = account.id;
      if (other === accountId) continue;
      let forcedOut = 0;
      const forcedIds = [];
      let possibleIn = 0;
      instructions.forEach((instruction, i) => {
        if (
          instruction.from === accountId &&
          instruction.to === other &&
          domains[i].size === 1 &&
          domains[i].has(NET)
        ) {
          forcedOut += instruction.amount;
          forcedIds.push(instruction.id);
        }
        if (instruction.from === other && instruction.to === accountId && domains[i].has(NET)) {
          possibleIn += instruction.amount;
        }
      });
      const bound = Math.max(0, forcedOut - possibleIn);
      if (bound > EPS) {
        total += bound;
        items.push({ ids: forcedIds.slice().sort(), c: bound });
      }
    }
    return { total, items };
  }

  // Irreducible subset of forced contributions whose sum still exceeds the limit.
  function minimalConflictItems(items, limit) {
    const sorted = items.filter((x) => x.c > EPS).sort((a, b) => b.c - a.c);
    const chosen = [];
    let sum = 0;
    for (const item of sorted) {
      if (sum <= limit + EPS) {
        chosen.push(item);
        sum += item.c;
      }
    }
    for (let k = chosen.length - 1; k >= 0; k -= 1) {
      if (sum - chosen[k].c > limit + EPS) {
        sum -= chosen[k].c;
        chosen.splice(k, 1);
      }
    }
    return { chosen, sum };
  }

  function makeLimitConflict(account, items, required) {
    const { chosen, sum } = minimalConflictItems(items, account.limit);
    const ids = [...new Set(chosen.flatMap((x) => x.ids))].sort();
    return {
      kind: 'LIMIT_EXCEEDED',
      account: account.id,
      limit: account.limit,
      requiredFreeze: round6(required),
      instructions: ids,
      minimal: true,
      explanation:
        `account "${account.id}" requires frozen ${fmt(sum)} from instructions ` +
        `${ids.join(', ')} which exceeds its limit ${fmt(account.limit)}; ` +
        'removing any of them fits the limit (minimal conflict set)',
    };
  }

  function makeEmptyDomainConflict(i) {
    const id = instructions[i].id;
    if (revokedSeq.has(id) && instructions[i].mandatory) {
      return {
        kind: 'REVOKED_MANDATORY',
        instruction: id,
        revocationSeq: revokedSeq.get(id),
        instructions: [id],
        minimal: true,
        explanation:
          `instruction "${id}" is mandatory (may not pend) but is revoked by ` +
          `revocation seq ${revokedSeq.get(id)} (may not freeze); no legal disposition`,
      };
    }
    return {
      kind: 'EMPTY_DOMAIN',
      instruction: id,
      instructions: [id],
      minimal: true,
      explanation: `instruction "${id}" has no feasible disposition left`,
    };
  }

  // Finite-domain propagation to a fixpoint. Returns a conflict or null.
  function propagate(domains) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < n; i += 1) {
        if (domains[i].size === 0) return makeEmptyDomainConflict(i);
      }
      let pairingPruned = false;
      for (let i = 0; i < n; i += 1) {
        if (domains[i].has(NET) && !reverseOf[i].some((j) => domains[j].has(NET))) {
          domains[i].delete(NET);
          changed = true;
          pairingPruned = true;
        }
      }
      if (pairingPruned) continue;
      for (const account of accounts) {
        const { total, items } = accountLowerBound(account.id, domains);
        if (total > account.limit + EPS) return makeLimitConflict(account, items, total);
        let pruned = false;
        for (let i = 0; i < n; i += 1) {
          if (instructions[i].from !== account.id || domains[i].size === 1) continue;
          for (const v of VALUE_ORDER) {
            if (!domains[i].has(v)) continue;
            const trial = domains.map((d) => new Set(d));
            trial[i] = new Set([v]);
            if (accountLowerBound(account.id, trial).total > account.limit + EPS) {
              domains[i].delete(v);
              changed = true;
              pruned = true;
            }
          }
        }
        if (pruned) break;
      }
    }
    return null;
  }

  const domains0 = instructions.map((instruction, i) => {
    const revoked = revokedSeq.has(instruction.id);
    const domain = revoked ? new Set([PEND]) : new Set([FULL, PEND]);
    if (!revoked && reverseOf[i].length > 0) domain.add(NET);
    if (instruction.mandatory) domain.delete(PEND);
    return domain;
  });

  let backtracks = 0;
  let exhausted = false;
  let lastConflict = null;
  let conflictPath = [];

  function snapshot(domains) {
    return domains.map((d) => VALUE_ORDER.filter((v) => d.has(v)));
  }

  function search(domains, path) {
    const conflict = propagate(domains);
    if (conflict) {
      lastConflict = conflict;
      conflictPath = path.slice();
      return null;
    }
    let pick = -1;
    for (let i = 0; i < n; i += 1) {
      if (domains[i].size > 1 && (pick === -1 || domains[i].size < domains[pick].size)) {
        pick = i;
      }
    }
    if (pick === -1) return domains;
    for (const v of VALUE_ORDER) {
      if (!domains[pick].has(v)) continue;
      const child = domains.map((d) => new Set(d));
      child[pick] = new Set([v]);
      path.push({ instruction: instructions[pick].id, disposition: v });
      const result = search(child, path);
      if (result) return result;
      path.pop();
      backtracks += 1;
      if (backtracks > budget) {
        exhausted = true;
        return null;
      }
    }
    return null;
  }

  const root = domains0.map((d) => new Set(d));
  const rootConflict = propagate(root);
  const rootDomains = snapshot(root);
  const path = [];
  let solution = null;
  if (rootConflict) {
    lastConflict = rootConflict;
  } else {
    solution = search(root, path);
  }

  const status = solution ? 'SETTLED' : exhausted ? 'PENDING' : 'UNSAT';

  let assignment = null;
  let freezes = null;
  if (solution) {
    assignment = solution.map((d) => [...d][0]);
    freezes = computeFreezes(accounts, instructions, assignment);
    // Greedy upgrade: any pended instruction that now fits is settled in full.
    for (let i = 0; i < n; i += 1) {
      if (assignment[i] !== PEND || revokedSeq.has(instructions[i].id)) continue;
      const instruction = instructions[i];
      if (freezes.get(instruction.from) + instruction.amount <= limitOf.get(instruction.from) + EPS) {
        assignment[i] = FULL;
        freezes.set(instruction.from, freezes.get(instruction.from) + instruction.amount);
      }
    }
  }

  function lowerBoundFreezes() {
    const totals = new Map();
    for (const account of accounts) {
      totals.set(account.id, accountLowerBound(account.id, root).total);
    }
    return totals;
  }

  function previousAssignment() {
    const map = (previous && previous.dispositions) || {};
    return instructions.map((instruction) => map[instruction.id] || PEND);
  }

  function releasedAmount(instructionId) {
    const i = instructions.findIndex((instruction) => instruction.id === instructionId);
    if (!previous) return instructions[i].amount;
    const base = previousAssignment();
    if (base[i] === PEND) return 0;
    const withAll = computeFreezes(accounts, instructions, base);
    const reduced = base.slice();
    reduced[i] = PEND;
    const without = computeFreezes(accounts, instructions, reduced);
    return withAll.get(instructions[i].from) - without.get(instructions[i].from);
  }

  // Revocations release the original freezes newest-first (reverse time order).
  const releaseEvents = revocations
    .slice()
    .sort((a, b) => b.seq - a.seq)
    .map((r) => ({
      seq: r.seq,
      instruction: r.instruction,
      released: round6(releasedAmount(r.instruction)),
    }));

  function pendingReasons(i) {
    const instruction = instructions[i];
    if (revokedSeq.has(instruction.id)) {
      return [{
        code: 'REVOKED',
        revocationSeq: revokedSeq.get(instruction.id),
        explanation:
          `revoked by revocation seq ${revokedSeq.get(instruction.id)}; ` +
          'a revoked instruction must not produce a new freeze',
      }];
    }
    const reasons = [];
    const headroom = limitOf.get(instruction.from) - freezes.get(instruction.from);
    if (instruction.amount > headroom + EPS) {
      reasons.push({
        code: 'INSUFFICIENT_LIMIT',
        explanation:
          `amount ${fmt(instruction.amount)} exceeds available limit ${fmt(headroom)} ` +
          `on account "${instruction.from}"`,
      });
    }
    if (reverseOf[i].length === 0) {
      reasons.push({
        code: 'NO_NETTING_PARTNER',
        explanation: 'no bidirectional counterpart instruction exists; netting unavailable',
      });
    }
    if (reasons.length === 0) {
      reasons.push({
        code: 'UNRESOLVED',
        explanation: 'no feasible settlement disposition under the current constraints',
      });
    }
    return reasons;
  }

  const certificate = {
    decisions: solution ? path.slice() : conflictPath,
    domainsAfterPropagation: Object.fromEntries(
      instructions.map((instruction, i) => [instruction.id, rootDomains[i]]),
    ),
    freezes: Object.fromEntries(
      [...(solution ? freezes : lowerBoundFreezes())].map(([k, v]) => [k, round6(v)]),
    ),
    revocations: releaseEvents,
    backtracks,
    budget,
    conflict: status === 'SETTLED' ? null : lastConflict,
  };

  if (previous && solution) {
    const before = previousAssignment();
    certificate.changes = instructions
      .map((instruction, i) => ({ instruction: instruction.id, from: before[i], to: assignment[i] }))
      .filter((change) => change.from !== change.to);
  }

  const output = { status };
  if (solution) {
    output.dispositions = instructions.map((instruction, i) => {
      const entry = { instruction: instruction.id, disposition: assignment[i] };
      if (assignment[i] === PEND) entry.reasons = pendingReasons(i);
      return entry;
    });
    output.freezes = Object.fromEntries([...freezes].map(([k, v]) => [k, round6(v)]));
  } else {
    output.dispositions = null;
    output.freezes = null;
  }
  output.certificate = certificate;
  return output;
}

module.exports = { solve, computeFreezes, FULL, NET, PEND };
