'use strict';

const DEFAULT_RULE = 'self';
const RULES = new Set(['self', 'parent']);

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function isNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

class Ledger {
  constructor() {
    this.nodes = new Map();
    this.chargebacks = new Map();
  }

  getNode(id) {
    const node = this.nodes.get(id);
    if (!node) {
      throw new LedgerError('E_UNKNOWN_NODE', `unknown node: ${id}`);
    }
    return node;
  }

  addNode({ id, parent = null, balance = 0, rule = null }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('E_INVALID_NODE', `invalid node id: ${JSON.stringify(id)}`);
    }
    if (this.nodes.has(id)) {
      throw new LedgerError('E_DUPLICATE_NODE', `duplicate node: ${id}`);
    }
    if (parent !== null && !this.nodes.has(parent)) {
      throw new LedgerError('E_UNKNOWN_NODE', `unknown parent node: ${parent}`);
    }
    if (!isNonNegativeInt(balance)) {
      throw new LedgerError('E_INVALID_AMOUNT', `invalid balance for node ${id}: ${balance}`);
    }
    if (rule !== null && !RULES.has(rule)) {
      throw new LedgerError('E_INVALID_RULE', `invalid rule for node ${id}: ${rule}`);
    }
    const depth = parent === null ? 0 : this.nodes.get(parent).depth + 1;
    this.nodes.set(id, { id, parent, balance, rule, depth });
    return { op: 'add_node', ok: true, id, depth };
  }

  effectiveRule(node) {
    let current = node;
    while (current) {
      if (current.rule !== null) return current.rule;
      current = current.parent === null ? null : this.nodes.get(current.parent);
    }
    return DEFAULT_RULE;
  }

  bearerPath(node) {
    const path = [];
    let current = node;
    while (current) {
      if (this.effectiveRule(current) === 'self') path.push(current);
      current = current.parent === null ? null : this.nodes.get(current.parent);
    }
    return path;
  }

  planChargeback(node, amount) {
    const steps = [];
    let remaining = amount;
    for (const bearer of this.bearerPath(node)) {
      if (remaining === 0) break;
      const take = Math.min(bearer.balance, remaining);
      if (take > 0) steps.push({ node: bearer.id, amount: take });
      remaining -= take;
    }
    return { steps, covered: amount - remaining, uncovered: remaining };
  }

  chargeback({ id, node: nodeId, amount }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('E_INVALID_CHARGEBACK', `invalid chargeback id: ${JSON.stringify(id)}`);
    }
    if (this.chargebacks.has(id)) {
      throw new LedgerError('E_DUPLICATE_CHARGEBACK', `duplicate chargeback: ${id}`);
    }
    const node = this.getNode(nodeId);
    if (!isPositiveInt(amount)) {
      throw new LedgerError('E_INVALID_AMOUNT', `invalid chargeback amount: ${amount}`);
    }
    const plan = this.planChargeback(node, amount);
    const steps = [];
    for (const step of plan.steps) {
      const bearer = this.nodes.get(step.node);
      bearer.balance -= step.amount;
      steps.push({ node: step.node, amount: step.amount, balanceAfter: bearer.balance });
    }
    const record = {
      id,
      node: nodeId,
      amount,
      covered: plan.covered,
      uncovered: plan.uncovered,
      status: plan.uncovered === 0 ? 'settled' : 'partial',
      steps,
      audit: [{ event: 'chargeback', node: nodeId, amount, covered: plan.covered, uncovered: plan.uncovered }],
    };
    this.chargebacks.set(id, record);
    return {
      op: 'chargeback',
      ok: plan.uncovered === 0,
      id,
      status: record.status,
      code: plan.uncovered === 0 ? null : 'E_INSUFFICIENT',
      covered: plan.covered,
      uncovered: plan.uncovered,
      steps,
    };
  }

  reverse({ chargeback: id }) {
    const record = this.chargebacks.get(id);
    if (!record) {
      throw new LedgerError('E_UNKNOWN_CHARGEBACK', `unknown chargeback: ${id}`);
    }
    if (record.status === 'reversed') {
      throw new LedgerError('E_ALREADY_REVERSED', `chargeback already reversed: ${id}`);
    }
    for (let i = record.steps.length - 1; i >= 0; i -= 1) {
      const step = record.steps[i];
      const node = this.nodes.get(step.node);
      if (node.balance !== step.balanceAfter) {
        record.audit.push({
          event: 'restore_failed',
          code: 'E_RESTORE',
          node: step.node,
          expected: step.balanceAfter,
          actual: node.balance,
        });
        return {
          op: 'reverse',
          ok: false,
          id,
          status: record.status,
          code: 'E_RESTORE',
          failedNode: step.node,
          expected: step.balanceAfter,
          actual: node.balance,
          restored: [],
        };
      }
    }
    const restored = [];
    for (let i = record.steps.length - 1; i >= 0; i -= 1) {
      const step = record.steps[i];
      const node = this.nodes.get(step.node);
      node.balance += step.amount;
      restored.push({ node: step.node, amount: step.amount, balanceAfter: node.balance });
    }
    record.status = 'reversed';
    record.audit.push({ event: 'restored', steps: restored.map((s) => ({ ...s })) });
    return { op: 'reverse', ok: true, id, status: record.status, code: null, restored };
  }

  adjust({ node: nodeId, delta }) {
    const node = this.getNode(nodeId);
    if (!Number.isSafeInteger(delta)) {
      throw new LedgerError('E_INVALID_AMOUNT', `invalid delta for node ${nodeId}: ${delta}`);
    }
    const next = node.balance + delta;
    if (next < 0) {
      throw new LedgerError('E_BALANCE', `adjust would make balance negative on ${nodeId}: ${next}`);
    }
    node.balance = next;
    return { op: 'adjust', ok: true, node: nodeId, balance: node.balance };
  }

  enumerate({ amount }) {
    if (!isPositiveInt(amount)) {
      throw new LedgerError('E_INVALID_AMOUNT', `invalid enumerate amount: ${amount}`);
    }
    const paths = [];
    for (const node of this.nodes.values()) {
      const plan = this.planChargeback(node, amount);
      paths.push({
        node: node.id,
        depth: node.depth,
        covered: plan.covered,
        uncovered: plan.uncovered,
        steps: plan.steps,
      });
    }
    paths.sort((a, b) =>
      b.covered - a.covered ||
      a.depth - b.depth ||
      (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
    return { op: 'enumerate', ok: true, amount, paths };
  }

  apply(op) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new LedgerError('E_INVALID_OP', `operation must be an object: ${JSON.stringify(op)}`);
    }
    switch (op.op) {
      case 'add_node': return this.addNode(op);
      case 'chargeback': return this.chargeback(op);
      case 'reverse': return this.reverse(op);
      case 'adjust': return this.adjust(op);
      case 'enumerate': return this.enumerate(op);
      default:
        throw new LedgerError('E_UNKNOWN_OP', `unknown op: ${JSON.stringify(op.op)}`);
    }
  }
}

function processJsonl(text) {
  const ledger = new Ledger();
  const results = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    const lineNo = i + 1;
    let op;
    try {
      op = JSON.parse(line);
    } catch (err) {
      throw new LedgerError('E_PARSE', `line ${lineNo}: invalid JSON: ${err.message}`);
    }
    let result;
    try {
      result = ledger.apply(op);
    } catch (err) {
      if (err instanceof LedgerError) {
        throw new LedgerError(err.code, `line ${lineNo}: ${err.message}`);
      }
      throw err;
    }
    results.push({ line: lineNo, ...result });
  }
  return { ledger, results };
}

module.exports = { Ledger, LedgerError, processJsonl };
