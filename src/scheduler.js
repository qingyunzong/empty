import { canonicalPlan, comparePlan, hashPlan, normalizeAlloc } from './canon.js';
import { BudgetError, NoPlanError } from './errors.js';

// Sum a plan's amounts per (material, day).
export function planUsage(plan) {
  const usage = new Map(); // "material\day" -> amount
  for (const raw of plan) {
    const a = normalizeAlloc(raw);
    const k = `${a.material} ${a.day}`;
    usage.set(k, (usage.get(k) ?? 0) + a.amount);
  }
  return usage;
}

function planFits(txn, plan) {
  for (const [k, amount] of planUsage(plan)) {
    const i = k.indexOf(' ');
    if (txn.remaining(k.slice(0, i), Number(k.slice(i + 1))) < amount) return false;
  }
  return true;
}

// Deterministically select a plan for one work order inside a transaction.
//
// All plans feasible under the transaction's snapshot are compared; the
// smallest by canonical-JSON lexicographic order wins. The certificate
// records the snapshot version, the chosen plan hash, and the hashes of
// every feasible plan that was compared, so the decision is auditable.
export function selectPlan(txn, order) {
  if (!Array.isArray(order.plans) || order.plans.length === 0) {
    throw new NoPlanError(`work order ${order.id} has no candidate plans`, { orderId: order.id });
  }
  const feasible = order.plans
    .map((plan) => ({ plan, canonical: canonicalPlan(plan) }))
    .filter(({ plan }) => planFits(txn, plan));
  if (feasible.length === 0) {
    throw new BudgetError(`no feasible plan for work order ${order.id} at snapshot ${txn.snapshotVersion}`, {
      orderId: order.id,
      snapshot: txn.snapshotVersion,
    });
  }
  feasible.sort((x, y) => comparePlan(x.canonical, y.canonical));
  const chosen = feasible[0];
  const certificate = {
    orderId: order.id,
    snapshot: txn.snapshotVersion,
    chosen: hashPlan(chosen.canonical),
    compared: feasible.map((f) => hashPlan(f.canonical)),
    plan: chosen.canonical,
  };
  return { plan: chosen.plan.map(normalizeAlloc), canonical: chosen.canonical, certificate };
}

// Convenience: schedule one order in its own transaction and commit.
export function scheduleOrder(store, order) {
  const txn = store.begin();
  const { plan, certificate } = selectPlan(txn, order);
  txn.stage(order.id, plan);
  const version = txn.commit();
  return { orderId: order.id, plan, certificate, version };
}

// Schedule a batch of orders sequentially, one committed transaction each.
export function scheduleBatch(store, orders) {
  const results = [];
  for (const order of orders) results.push(scheduleOrder(store, order));
  return { version: store.version, results };
}

// Enumerate every jointly feasible assignment of plans to orders given
// budgets: a DFS over orders x plans pruning on per-(material, day) budget
// predicates. Returns assignments as arrays of canonical plan strings in
// input order order. Used as the exhaustive reference for small instances.
export function enumerateJointPlans(orders, budgets) {
  const budgetMap = new Map();
  for (const b of budgets) budgetMap.set(`${b.material} ${b.day}`, b.amount);
  const usages = orders.map((o) => o.plans.map((p) => planUsage(p)));
  const results = [];
  const chosen = new Array(orders.length);
  const spent = new Map();

  function fits(usage) {
    for (const [k, amount] of usage) {
      const used = (spent.get(k) ?? 0) + amount;
      if (used > (budgetMap.get(k) ?? 0)) return false;
    }
    return true;
  }
  function apply(usage, sign) {
    for (const [k, amount] of usage) spent.set(k, (spent.get(k) ?? 0) + sign * amount);
  }
  function dfs(i) {
    if (i === orders.length) {
      results.push(chosen.slice());
      return;
    }
    const order = orders[i];
    for (let p = 0; p < order.plans.length; p += 1) {
      const usage = usages[i][p];
      if (!fits(usage)) continue;
      apply(usage, +1);
      chosen[i] = canonicalPlan(order.plans[p]);
      dfs(i + 1);
      apply(usage, -1);
    }
  }
  dfs(0);
  return results;
}

// Optimal joint schedule: the lexicographically smallest tuple of canonical
// plans among all jointly feasible assignments, committed as one
// transaction. Throws BudgetError if no joint assignment exists.
export function scheduleJoint(store, orders, budgets) {
  const feasible = enumerateJointPlans(orders, budgets);
  if (feasible.length === 0) {
    throw new BudgetError('no jointly feasible assignment', {
      orderIds: orders.map((o) => o.id),
    });
  }
  feasible.sort((a, b) => {
    const ja = a.join('');
    const jb = b.join('');
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });
  const best = feasible[0];
  const txn = store.begin();
  orders.forEach((order, i) => txn.stage(order.id, JSON.parse(best[i])));
  const version = txn.commit();
  return { version, assignment: best.map((canonical, i) => ({ orderId: orders[i].id, plan: canonical })) };
}
