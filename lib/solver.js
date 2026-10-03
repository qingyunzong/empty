'use strict';

function amountOf(instruction) {
  return instruction.price * instruction.quantity;
}

// Remaining capacity per account = initial balances minus frozen amounts.
function computeRemaining(accounts, frozen) {
  const remaining = {};
  for (const account of accounts) {
    remaining[account.id] = {
      cash: account.cash || 0,
      positions: { ...(account.positions || {}) },
    };
  }
  for (const [accountId, entry] of Object.entries(frozen || {})) {
    if (!remaining[accountId]) remaining[accountId] = { cash: 0, positions: {} };
    remaining[accountId].cash -= entry.cash || 0;
    for (const [security, qty] of Object.entries(entry.positions || {})) {
      remaining[accountId].positions[security] =
        (remaining[accountId].positions[security] || 0) - qty;
    }
  }
  return remaining;
}

// Propagation: delete impossible accounts from each instruction's domain.
// A buy needs cash >= price*quantity; a sell needs positions[security] >= quantity.
function buildDomains(instructions, accounts, remaining) {
  const domains = new Map();
  for (const instruction of instructions) {
    const whitelist = instruction.accounts ? new Set(instruction.accounts) : null;
    const domain = [];
    for (const account of accounts) {
      if (whitelist && !whitelist.has(account.id)) continue;
      const capacity = remaining[account.id];
      if (!capacity) continue;
      if (instruction.side === 'buy') {
        if (capacity.cash >= amountOf(instruction)) domain.push(account.id);
      } else if ((capacity.positions[instruction.security] || 0) >= instruction.quantity) {
        domain.push(account.id);
      }
    }
    domains.set(instruction.id, domain);
  }
  return domains;
}

function makePairAllowed(permissions) {
  if (!permissions) return () => true;
  const allowed = new Set(permissions.map((pair) => [...pair].sort().join('')));
  return (buyId, sellId) => allowed.has([buyId, sellId].sort().join(''));
}

function termsMatch(buy, sell) {
  return (
    buy.security === sell.security &&
    buy.price === sell.price &&
    buy.quantity === sell.quantity
  );
}

// Backtracking search over pairings with forward checking.
// Every instruction in `mustMatch` must end up in exactly one pair;
// any instruction may be used as a counterparty at most once.
// With collectAll=true, enumerates all maximal solutions (used for <=4 instructions).
function findMatching({ instructions, remaining, permissions, mustMatch, domains, collectAll = false }) {
  const allowed = makePairAllowed(permissions);
  const targets = instructions.filter((i) => mustMatch.has(i.id));
  const rem = structuredClone(remaining);
  const used = new Set();
  const pairs = [];
  const solutions = [];

  function combosFor(target) {
    const combos = [];
    for (const other of instructions) {
      if (other.id === target.id || other.side === target.side || used.has(other.id)) continue;
      const buy = target.side === 'buy' ? target : other;
      const sell = target.side === 'buy' ? other : target;
      if (!termsMatch(buy, sell) || !allowed(buy.id, sell.id)) continue;
      for (const buyAccount of domains.get(buy.id)) {
        if (rem[buyAccount].cash < amountOf(buy)) continue;
        for (const sellAccount of domains.get(sell.id)) {
          if ((rem[sellAccount].positions[sell.security] || 0) < sell.quantity) continue;
          combos.push({ buy, sell, buyAccount, sellAccount });
        }
      }
    }
    return combos;
  }

  function dfs() {
    const open = targets.filter((t) => !used.has(t.id));
    if (open.length === 0) {
      solutions.push(pairs.map((p) => ({ ...p })));
      return !collectAll;
    }
    // MRV: branch on the target with the fewest feasible combinations.
    let best = null;
    let bestCombos = null;
    for (const target of open) {
      const combos = combosFor(target);
      if (combos.length === 0) return false; // propagation: dead end, backtrack
      if (!bestCombos || combos.length < bestCombos.length) {
        best = target;
        bestCombos = combos;
      }
    }
    for (const combo of bestCombos) {
      used.add(combo.buy.id);
      used.add(combo.sell.id);
      rem[combo.buyAccount].cash -= amountOf(combo.buy);
      rem[combo.sellAccount].positions[combo.sell.security] -= combo.sell.quantity;
      pairs.push({
        buy: combo.buy.id,
        sell: combo.sell.id,
        security: combo.buy.security,
        price: combo.buy.price,
        quantity: combo.buy.quantity,
        buyAccount: combo.buyAccount,
        sellAccount: combo.sellAccount,
        amount: amountOf(combo.buy),
      });
      const done = dfs();
      pairs.pop();
      rem[combo.buyAccount].cash += amountOf(combo.buy);
      rem[combo.sellAccount].positions[combo.sell.security] += combo.sell.quantity;
      used.delete(combo.buy.id);
      used.delete(combo.sell.id);
      if (done) return true;
    }
    return false;
  }

  dfs();
  if (collectAll) return solutions;
  return solutions.length > 0 ? solutions[0] : null;
}

function enumerateMatchings(args) {
  return findMatching({ ...args, collectAll: true });
}

function* combinations(items, k) {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - k; i++) {
    for (const rest of combinations(items.slice(i + 1), k - 1)) {
      yield [items[i], ...rest];
    }
  }
}

// Smallest subset of `items` whose combined weight exceeds `supply`.
function minimalExceeding(items, weight, supply) {
  for (let k = 1; k <= items.length; k++) {
    for (const idxs of combinations(items.map((_, i) => i), k)) {
      const subset = idxs.map((i) => items[i]);
      if (subset.reduce((sum, item) => sum + weight(item), 0) > supply) return subset;
    }
  }
  return null;
}

// Conflict explanation: minimal infeasible instruction set, expressed as the
// shortest cycle of instructions contending for one shared resource.
function explainConflict({ instructions, accounts, remaining, permissions, domains }) {
  let core = null;
  const limit = Math.min(instructions.length, 6);
  for (let k = 1; k <= limit && !core; k++) {
    for (const idxs of combinations(instructions.map((_, i) => i), k)) {
      const subset = idxs.map((i) => instructions[i]);
      const feasible = findMatching({
        instructions,
        remaining,
        permissions,
        mustMatch: new Set(subset.map((i) => i.id)),
        domains,
      });
      if (!feasible) {
        core = subset;
        break;
      }
    }
  }
  if (!core) core = instructions;
  return buildCycle({ core, instructions, accounts, remaining, permissions, domains });
}

function buildCycle({ core, instructions, accounts, remaining, permissions, domains }) {
  if (core.length === 1) {
    const target = core[0];
    const domain = domains.get(target.id) || [];
    if (domain.length === 0) {
      const kind = target.side === 'buy' ? 'cash' : 'security';
      return {
        cycle: [target.id],
        kind,
        resource: null,
        detail: `instruction ${target.id} has no account with sufficient ${kind}`,
      };
    }
    return {
      cycle: [target.id],
      kind: 'counterparty',
      resource: null,
      detail: `instruction ${target.id} has no permissible counterparty with equal price and quantity`,
    };
  }

  let best = null;
  const offer = (cycle, kind, resource, detail) => {
    if (!best || cycle.length < best.cycle.length) best = { cycle, kind, resource, detail };
  };

  // Contention for one account's cash or securities.
  for (const account of accounts) {
    const capacity = remaining[account.id] || { cash: 0, positions: {} };
    const cashUsers = core.filter(
      (i) => i.side === 'buy' && (domains.get(i.id) || []).includes(account.id)
    );
    const cashHit = minimalExceeding(cashUsers, amountOf, capacity.cash);
    if (cashHit) {
      const demand = cashHit.reduce((sum, i) => sum + amountOf(i), 0);
      offer(
        cashHit.map((i) => i.id),
        'cash',
        account.id,
        `combined cash demand ${demand} exceeds available ${capacity.cash} on account ${account.id}`
      );
    }
    const securities = new Set(core.filter((i) => i.side === 'sell').map((i) => i.security));
    for (const security of securities) {
      const users = core.filter(
        (i) =>
          i.side === 'sell' &&
          i.security === security &&
          (domains.get(i.id) || []).includes(account.id)
      );
      const hit = minimalExceeding(users, (i) => i.quantity, capacity.positions[security] || 0);
      if (hit) {
        const demand = hit.reduce((sum, i) => sum + i.quantity, 0);
        offer(
          hit.map((i) => i.id),
          'security',
          account.id,
          `combined ${security} demand ${demand} exceeds available ${capacity.positions[security] || 0} on account ${account.id}`
        );
      }
    }
  }

  // Contention for counterparties (Hall violation): more instructions than permissible partners.
  const allowed = makePairAllowed(permissions);
  for (const side of ['buy', 'sell']) {
    const group = core.filter((i) => i.side === side);
    for (let k = 2; k <= group.length; k++) {
      for (const idxs of combinations(group.map((_, i) => i), k)) {
        const subset = idxs.map((i) => group[i]);
        const neighbourhood = instructions.filter(
          (other) =>
            other.side !== side &&
            subset.some((t) => {
              const buy = side === 'buy' ? t : other;
              const sell = side === 'buy' ? other : t;
              return termsMatch(buy, sell) && allowed(buy.id, sell.id);
            })
        );
        if (neighbourhood.length < subset.length) {
          const ids = subset.map((i) => i.id);
          const cycle =
            subset.length === 2 && neighbourhood.length === 1
              ? [ids[0], neighbourhood[0].id, ids[1]]
              : ids;
          offer(
            cycle,
            'counterparty',
            neighbourhood.map((n) => n.id).join(','),
            `${ids.join(',')} contend for ${neighbourhood.length} permissible counterparty(ies)`
          );
        }
      }
    }
  }

  if (!best) {
    best = {
      cycle: core.map((i) => i.id),
      kind: 'unknown',
      resource: null,
      detail: 'minimal infeasible instruction set',
    };
  }
  return best;
}

module.exports = {
  amountOf,
  computeRemaining,
  buildDomains,
  findMatching,
  enumerateMatchings,
  explainConflict,
};
