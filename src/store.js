import { normalizeAlloc } from './canon.js';
import { BudgetError, SchedError } from './errors.js';

const SEP = '';

function keyOf(material, day) {
  return `${material}${SEP}${day}`;
}

function parseKey(key) {
  const i = key.indexOf(SEP);
  return { material: key.slice(0, i), day: Number(key.slice(i + 1)) };
}

function checkAmount(amount, what) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new SchedError('E_INVALID', `${what} must be a non-negative integer, got ${amount}`);
  }
}

// MVCC store with snapshot isolation.
//
// Committed state is versioned. Budgets and allocations are visible to a
// transaction exactly as of its snapshot version. A secondary index maps
// (material, day) -> versioned allocation entries so budget predicates can
// be evaluated without scanning unrelated allocations.
export class Store {
  #version = 0;
  #budgets = new Map(); // key -> {material, day, amount, version}
  #index = new Map();   // key -> [{version, orderId, machine, day, material, amount}]
  #commits = [];        // [{version, orderId, plan}]

  get version() {
    return this.#version;
  }

  // Budgets are committed immediately as their own version bump so that
  // later snapshots observe them deterministically.
  setBudget(material, day, amount) {
    checkAmount(amount, 'budget amount');
    this.#version += 1;
    this.#budgets.set(keyOf(material, day), { material, day, amount, version: this.#version });
    return this.#version;
  }

  budgetAt(material, day, uptoVersion = Infinity) {
    const b = this.#budgets.get(keyOf(material, day));
    if (!b || b.version > uptoVersion) return 0;
    return b.amount;
  }

  // Sum of committed allocations for (material, day) visible at a version,
  // served from the secondary index.
  committedSum(material, day, uptoVersion = Infinity) {
    const entries = this.#index.get(keyOf(material, day));
    if (!entries) return 0;
    let sum = 0;
    for (const e of entries) {
      if (e.version <= uptoVersion) sum += e.amount;
    }
    return sum;
  }

  begin() {
    return new Txn(this, this.#version);
  }

  // Commit protocol: recompute, for every (material, day) the transaction
  // touches, the sum of ALL committed allocations at the latest version
  // (not the transaction snapshot) plus the staged amounts, and reject if
  // any budget predicate would be violated. This closes the write-skew
  // hole where two transactions writing different work orders share a
  // budget predicate.
  _commit(txn, staged) {
    const touched = new Map(); // key -> staged amount
    for (const { plan } of staged) {
      for (const raw of plan) {
        const a = normalizeAlloc(raw);
        const k = keyOf(a.material, a.day);
        touched.set(k, (touched.get(k) ?? 0) + a.amount);
      }
    }
    for (const [k, stagedAmount] of touched) {
      const { material, day } = parseKey(k);
      const committed = this.committedSum(material, day);
      const budget = this.budgetAt(material, day);
      if (committed + stagedAmount > budget) {
        throw new BudgetError(
          `budget exceeded for material=${material} day=${day}: ` +
            `committed=${committed} + staged=${stagedAmount} > budget=${budget}`,
          { material, day, committed, staged: stagedAmount, budget },
        );
      }
    }
    this.#version += 1;
    const version = this.#version;
    for (const { orderId, plan } of staged) {
      const normalized = plan.map(normalizeAlloc);
      for (const a of normalized) {
        const k = keyOf(a.material, a.day);
        let entries = this.#index.get(k);
        if (!entries) {
          entries = [];
          this.#index.set(k, entries);
        }
        entries.push({ version, orderId, ...a });
      }
      this.#commits.push({ version, orderId, plan: normalized });
    }
    return version;
  }

  committedAllocations() {
    return this.#commits.map((c) => ({ ...c, plan: c.plan.map((a) => ({ ...a })) }));
  }
}

export class Txn {
  #store;
  #snapshot;
  #staged = [];
  #done = false;

  constructor(store, snapshot) {
    this.#store = store;
    this.#snapshot = snapshot;
  }

  get snapshotVersion() {
    return this.#snapshot;
  }

  // Budget reads are served from the snapshot: committed allocations and
  // budgets as of the snapshot version.
  remaining(material, day) {
    return (
      this.#store.budgetAt(material, day, this.#snapshot) -
      this.#store.committedSum(material, day, this.#snapshot)
    );
  }

  // Stage a chosen plan for a work order. Amounts are validated here so
  // commit-time arithmetic is over well-formed integers.
  stage(orderId, plan) {
    if (this.#done) throw new SchedError('E_TXN_CLOSED', 'transaction already finished');
    for (const raw of plan) checkAmount(raw.amount, 'allocation amount');
    this.#staged.push({ orderId, plan: plan.map(normalizeAlloc) });
  }

  commit() {
    if (this.#done) throw new SchedError('E_TXN_CLOSED', 'transaction already finished');
    this.#done = true;
    return this.#store._commit(this, this.#staged);
  }

  abort() {
    this.#done = true;
    this.#staged = [];
  }
}
