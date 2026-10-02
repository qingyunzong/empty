'use strict';
const { MVCCStore } = require('./mvcc');
const { canonicalJSON, sha256, compareCanonical } = require('./canonical');
const { assertName, assertNonNegativeInteger, validatePlan, aggregatePlan } = require('./model');

const ALLOC_PREFIX = 'alloc|';
const BUDGET_PREFIX = 'budget|';
const ORDER_PREFIX = 'order|';
const INDEX_BY_MATERIAL_DAY = 'byMaterialDay';

const budgetKey = (m, d) => `${BUDGET_PREFIX}${m}|${d}`;
const orderKey = (id) => `${ORDER_PREFIX}${id}`;
const allocKey = (id) => `${ALLOC_PREFIX}${id}`;

class SchedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SchedError';
    this.code = code;
    this.details = details;
  }
}

function sumPlanFor(plan, material, day) {
  let sum = 0;
  for (const a of plan) {
    if (a.material === material && a.day === day) sum += a.amount;
  }
  return sum;
}

// Evaluate every candidate plan of an order against a budget view.
// view = { getLimit(material, day) -> number|undefined, getUsed(material, day) -> number }
function evaluatePlans(order, view) {
  const candidates = order.plans.map((plan) => {
    const requirements = [];
    let feasible = true;
    for (const [key, amount] of aggregatePlan(plan)) {
      const sep = key.lastIndexOf('|');
      const material = key.slice(0, sep);
      const day = Number(key.slice(sep + 1));
      const limit = view.getLimit(material, day) ?? 0;
      const used = view.getUsed(material, day);
      if (used + amount > limit) feasible = false;
      requirements.push({ material, day, amount, limit, usedBefore: used });
    }
    requirements.sort(compareCanonical);
    return { plan, hash: sha256(plan), canonical: canonicalJSON(plan), feasible, requirements };
  });
  candidates.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));
  const chosen = candidates.find((c) => c.feasible) ?? null;
  return { candidates, chosen };
}

class Scheduler {
  constructor(store) {
    this.store = store ?? new MVCCStore();
    if (!this.store.indexes.has(INDEX_BY_MATERIAL_DAY)) {
      // Secondary index: (material, day) -> committed allocation records.
      this.store.defineIndex(INDEX_BY_MATERIAL_DAY, (key, value) => {
        if (!key.startsWith(ALLOC_PREFIX)) return [];
        return value.plan.map((a) => `${a.material}|${a.day}`);
      });
    }
  }

  setBudget(material, day, limit) {
    assertName('material', material);
    assertNonNegativeInteger('day', day);
    assertNonNegativeInteger('limit', limit);
    const txn = this.store.begin();
    txn.put(budgetKey(material, day), { material, day, limit });
    txn.commit();
    return { material, day, limit };
  }

  addOrder(id, plans) {
    assertName('order id', id);
    if (!Array.isArray(plans) || plans.length === 0) {
      throw new SchedError('E_ORDER_PLANS', `order ${id} must have at least one candidate plan`);
    }
    const normalized = plans.map(validatePlan).sort(compareCanonical);
    const txn = this.store.begin();
    if (txn.get(orderKey(id)) !== undefined) {
      throw new SchedError('E_ORDER_EXISTS', `order already exists: ${id}`);
    }
    txn.put(orderKey(id), { id, plans: normalized, status: 'pending' });
    txn.commit();
    return { id, plans: normalized, status: 'pending' };
  }

  getOrder(id) {
    return this.store.latest(orderKey(id));
  }

  getBudget(material, day) {
    return this.store.latest(budgetKey(material, day));
  }

  allocations() {
    const out = [];
    for (const [key, chain] of this.store.data) {
      if (!key.startsWith(ALLOC_PREFIX) || chain.length === 0) continue;
      out.push(chain[chain.length - 1].value);
    }
    return out.sort(compareCanonical);
  }

  // Sum of committed allocations for (material, day) via the secondary index.
  committedUsage(material, day) {
    let sum = 0;
    for (const { value } of this.store.indexEntries(INDEX_BY_MATERIAL_DAY, `${material}|${day}`)) {
      sum += sumPlanFor(value.plan, material, day);
    }
    return sum;
  }

  begin() {
    return new SchedulerTxn(this);
  }

  // Dry run: evaluate candidates at the current snapshot without committing.
  planOrder(id) {
    const txn = this.begin();
    txn.stageOrder(id);
    return { orderId: id, certificate: txn.previewCertificate(id) };
  }

  // Auto-commit convenience wrapper.
  scheduleOrder(id) {
    const txn = this.begin();
    txn.stageOrder(id);
    const result = txn.commit();
    return { orderId: id, commitSeq: result.commitSeq, certificate: result.certificates.get(id) };
  }
}

class SchedulerTxn {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.txn = scheduler.store.begin();
    this.staged = new Map(); // orderId -> { order, candidates, chosen }
  }

  get snapshotSeq() {
    return this.txn.snapshotSeq;
  }

  _snapshotView() {
    const txn = this.txn;
    const allocs = txn.scan(ALLOC_PREFIX).map((e) => e.value);
    return {
      getLimit: (m, d) => {
        const b = txn.get(budgetKey(m, d));
        return b === undefined ? undefined : b.limit;
      },
      getUsed: (m, d) => {
        let sum = 0;
        for (const alloc of allocs) sum += sumPlanFor(alloc.plan, m, d);
        return sum;
      },
    };
  }

  // Read budgets from the snapshot, evaluate candidate plans and stage the
  // deterministic winner (lexicographically smallest canonical JSON among
  // feasible plans).
  stageOrder(id) {
    if (this.staged.has(id)) throw new SchedError('E_ORDER_STATE', `order already staged: ${id}`);
    const order = this.txn.get(orderKey(id));
    if (order === undefined) throw new SchedError('E_ORDER_NOT_FOUND', `unknown order: ${id}`);
    if (order.status !== 'pending') {
      throw new SchedError('E_ORDER_STATE', `order not pending: ${id} (${order.status})`);
    }
    const { candidates, chosen } = evaluatePlans(order, this._snapshotView());
    if (!chosen) {
      throw new SchedError('E_BUDGET', `no feasible plan for order within budget: ${id}`, {
        orderId: id,
        candidates: candidates.map((c) => ({ hash: c.hash, feasible: c.feasible })),
      });
    }
    this.staged.set(id, { order, candidates, chosen });
    return chosen.plan;
  }

  previewCertificate(id) {
    const staged = this.staged.get(id);
    if (!staged) throw new SchedError('E_ORDER_STATE', `order not staged: ${id}`);
    return {
      orderId: id,
      commitSeq: null,
      chosen: { hash: staged.chosen.hash, plan: staged.chosen.plan },
      compared: staged.candidates.map((c) => ({ hash: c.hash, plan: c.plan, feasible: c.feasible })),
      budgets: staged.chosen.requirements.map((r) => ({ ...r, usedAfter: null })),
    };
  }

  commit() {
    if (this.staged.size === 0) throw new SchedError('E_EMPTY_TXN', 'nothing staged');
    const scheduler = this.scheduler;
    for (const [id, staged] of this.staged) {
      this.txn.put(allocKey(id), { orderId: id, plan: staged.chosen.plan });
      this.txn.put(orderKey(id), { ...staged.order, status: 'scheduled' });
      // Commit-time revalidation: recompute the total of ALL committed
      // allocations for every (material, day) this order touches, using the
      // secondary index over the latest committed state. This predicate is
      // shared across orders, so two transactions writing different orders
      // cannot both pass against the same budget.
      this.txn.addValidator((store) => {
        for (const req of staged.chosen.requirements) {
          const budget = store.latest(budgetKey(req.material, req.day));
          const limit = budget === undefined ? 0 : budget.limit;
          let total = 0;
          for (const { value } of store.indexEntries(INDEX_BY_MATERIAL_DAY, `${req.material}|${req.day}`)) {
            total += sumPlanFor(value.plan, req.material, req.day);
          }
          if (total > limit) {
            throw new SchedError(
              'E_BUDGET',
              `budget exceeded for material=${req.material} day=${req.day}: ${total} > ${limit}`,
              { material: req.material, day: req.day, total, limit, orderId: id },
            );
          }
        }
      });
    }
    const commitSeq = this.txn.commit();
    const certificates = new Map();
    for (const [id, staged] of this.staged) {
      const budgets = staged.chosen.requirements.map((req) => {
        const budget = scheduler.getBudget(req.material, req.day);
        const usedAfter = scheduler.committedUsage(req.material, req.day);
        return {
          material: req.material,
          day: req.day,
          amount: req.amount,
          limit: budget === undefined ? 0 : budget.limit,
          usedBefore: usedAfter - req.amount,
          usedAfter,
        };
      });
      certificates.set(id, {
        orderId: id,
        commitSeq,
        chosen: { hash: staged.chosen.hash, plan: staged.chosen.plan },
        compared: staged.candidates.map((c) => ({ hash: c.hash, plan: c.plan, feasible: c.feasible })),
        budgets,
      });
    }
    return { commitSeq, certificates };
  }
}

module.exports = { Scheduler, SchedulerTxn, SchedError, evaluatePlans };
