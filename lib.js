export class ChargebackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChargebackError';
  }
}

const DEFAULT_LIABLE = true;

function assertId(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ChargebackError(`${what} must be a non-empty string`);
  }
}

function assertNonNegativeInt(value, what) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ChargebackError(`${what} must be a non-negative integer`);
  }
}

export function comparePlans(a, b) {
  if (a.covered !== b.covered) return b.covered - a.covered;
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  return 0;
}

export class Ledger {
  #nodes = new Map();
  #chargebacks = new Map();
  #seq = 0;
  audit = [];

  addNode({id, parent = null, balance = 0, rule = null} = {}) {
    assertId(id, 'node id');
    if (this.#nodes.has(id)) throw new ChargebackError(`duplicate node id: ${id}`);
    if (parent !== null) {
      assertId(parent, 'parent id');
      if (!this.#nodes.has(parent)) throw new ChargebackError(`unknown parent node: ${parent}`);
    }
    assertNonNegativeInt(balance, `balance of ${id}`);
    if (rule !== null) {
      if (typeof rule !== 'object' || Array.isArray(rule) || typeof rule.liable !== 'boolean') {
        throw new ChargebackError(`rule of ${id} must be {"liable": boolean}`);
      }
      rule = {liable: rule.liable};
    }
    this.#nodes.set(id, {id, parent, balance, rule});
    return {type: 'node', id, code: 'OK'};
  }

  #node(id) {
    const n = this.#nodes.get(id);
    if (!n) throw new ChargebackError(`unknown node: ${id}`);
    return n;
  }

  balance(id) {
    return this.#node(id).balance;
  }

  balances() {
    const out = {};
    for (const [id, n] of this.#nodes) out[id] = n.balance;
    return out;
  }

  depth(id) {
    let d = 0;
    let n = this.#node(id);
    while (n.parent !== null) {
      d += 1;
      n = this.#node(n.parent);
    }
    return d;
  }

  effectiveLiable(id) {
    let n = this.#node(id);
    for (;;) {
      if (n.rule !== null) return n.rule.liable;
      if (n.parent === null) return DEFAULT_LIABLE;
      n = this.#node(n.parent);
    }
  }

  #lineage(start) {
    const ids = [];
    let n = this.#node(start);
    for (;;) {
      ids.push(n.id);
      if (n.parent === null) return ids;
      n = this.#node(n.parent);
    }
  }

  plan(start, amount) {
    assertId(start, 'start node');
    assertNonNegativeInt(amount, 'amount');
    const steps = [];
    let remaining = amount;
    for (const id of this.#lineage(start)) {
      if (remaining === 0) break;
      if (!this.effectiveLiable(id)) continue;
      const n = this.#node(id);
      const take = Math.min(n.balance, remaining);
      if (take > 0) steps.push({node: id, amount: take});
      remaining -= take;
    }
    return {
      start,
      depth: this.depth(start),
      amount,
      covered: amount - remaining,
      uncovered: remaining,
      steps,
    };
  }

  enumeratePlans(amount, root = null) {
    assertNonNegativeInt(amount, 'amount');
    let starts;
    if (root === null || root === undefined) {
      starts = [...this.#nodes.keys()];
    } else {
      this.#node(root);
      starts = [...this.#nodes.values()]
        .filter((n) => this.#lineage(n.id).includes(root))
        .map((n) => n.id);
    }
    const plans = starts.map((s) => this.plan(s, amount));
    plans.sort(comparePlans);
    return plans;
  }

  route({id, root = null, amount} = {}) {
    assertId(id, 'route id');
    const candidates = this.enumeratePlans(amount, root ?? null);
    const chosen = candidates.length > 0 ? candidates[0] : null;
    this.#audit({
      type: 'route',
      id,
      root: root ?? null,
      amount,
      chosen: chosen ? chosen.start : null,
    });
    return {type: 'route', id, code: 'OK', chosen, candidates};
  }

  chargeback({id, node = null, candidates = null, amount} = {}) {
    assertId(id, 'chargeback id');
    if (this.#chargebacks.has(id)) throw new ChargebackError(`duplicate chargeback id: ${id}`);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ChargebackError('chargeback amount must be a positive integer');
    }
    if (node !== null && candidates !== null) {
      throw new ChargebackError('specify either node or candidates, not both');
    }
    let start;
    if (candidates !== null) {
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new ChargebackError('candidates must be a non-empty array');
      }
      const plans = candidates.map((c) => this.plan(c, amount));
      plans.sort(comparePlans);
      start = plans[0].start;
    } else {
      if (node === null) throw new ChargebackError('chargeback requires node or candidates');
      assertId(node, 'node');
      this.#node(node);
      start = node;
    }
    const steps = [];
    let remaining = amount;
    for (const nid of this.#lineage(start)) {
      if (remaining === 0) break;
      if (!this.effectiveLiable(nid)) continue;
      const n = this.#node(nid);
      const take = Math.min(n.balance, remaining);
      if (take > 0) {
        const before = n.balance;
        n.balance -= take;
        steps.push({node: nid, amount: take, balanceBefore: before, balanceAfter: n.balance});
        remaining -= take;
      }
    }
    const code = remaining > 0 ? 'E_INSUFFICIENT' : 'OK';
    const record = {
      type: 'chargeback',
      id,
      code,
      start,
      amount,
      covered: amount - remaining,
      uncovered: remaining,
      steps,
      restored: null,
    };
    this.#chargebacks.set(id, record);
    this.#audit({
      type: 'chargeback',
      id,
      code,
      start,
      amount,
      covered: record.covered,
      uncovered: remaining,
      steps: steps.map((s) => ({...s})),
    });
    return record;
  }

  chargebackRecord(id) {
    const r = this.#chargebacks.get(id);
    if (!r) throw new ChargebackError(`unknown chargeback: ${id}`);
    return r;
  }

  reverse({id, chargeback} = {}) {
    assertId(id, 'reverse id');
    assertId(chargeback, 'chargeback id');
    const cb = this.#chargebacks.get(chargeback);
    if (!cb) throw new ChargebackError(`unknown chargeback: ${chargeback}`);
    if (cb.restored !== null && cb.restored.code === 'OK') {
      this.#audit({type: 'restore', id, chargeback, code: 'E_STATE'});
      return {type: 'reverse', id, code: 'E_STATE', chargeback, detail: 'already reversed'};
    }
    const drift = [];
    for (const step of cb.steps) {
      const current = this.#node(step.node).balance;
      if (current !== step.balanceAfter) {
        drift.push({node: step.node, expected: step.balanceAfter, actual: current});
      }
    }
    if (drift.length > 0) {
      cb.restored = {code: 'E_RESTORE', by: id};
      this.#audit({type: 'restore', id, chargeback, code: 'E_RESTORE', drift});
      return {type: 'reverse', id, code: 'E_RESTORE', chargeback, drift};
    }
    const steps = [];
    for (const step of [...cb.steps].reverse()) {
      const n = this.#node(step.node);
      const before = n.balance;
      n.balance += step.amount;
      steps.push({node: step.node, amount: step.amount, balanceBefore: before, balanceAfter: n.balance});
    }
    cb.restored = {code: 'OK', by: id};
    this.#audit({type: 'restore', id, chargeback, code: 'OK', steps: steps.map((s) => ({...s}))});
    return {type: 'reverse', id, code: 'OK', chargeback, steps};
  }

  #audit(event) {
    this.#seq += 1;
    this.audit.push({seq: this.#seq, ...event});
  }
}

export function applyOp(ledger, obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ChargebackError('each line must be a JSON object');
  }
  switch (obj.type) {
    case 'node':
      return ledger.addNode(obj);
    case 'chargeback':
      return ledger.chargeback(obj);
    case 'reverse':
      return ledger.reverse(obj);
    case 'route':
      return ledger.route(obj);
    default:
      throw new ChargebackError(`unknown op type: ${JSON.stringify(obj.type)}`);
  }
}
