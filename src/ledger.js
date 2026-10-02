import { createHash } from 'node:crypto';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function canonicalInstruction({ id, payer, payee, amount }) {
  return { amount, id, payee, payer };
}

export function hashInstruction(instruction) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalInstruction(instruction)))
    .digest('hex');
}

function normalizeInstruction(input) {
  if (!isPlainObject(input)) {
    throw new LedgerError('invalid-event', 'instruction must be an object');
  }
  const { id, payer, payee, amount } = input;
  if (!isNonEmptyString(id)) {
    throw new LedgerError('invalid-event', 'instruction id must be a non-empty string');
  }
  if (!isNonEmptyString(payer) || !isNonEmptyString(payee)) {
    throw new LedgerError('invalid-event', 'payer and payee must be non-empty strings');
  }
  if (!isValidAmount(amount)) {
    throw new LedgerError('invalid-amount', 'amount must be a positive finite number');
  }
  return { id, payer, payee, amount };
}

function sortedObject(entries) {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export class Ledger {
  constructor({ budgets = {} } = {}) {
    this.instructions = new Map();
    this.order = [];
    this.tombstones = new Map();
    this.budgets = new Map(Object.entries(budgets));
  }

  instruct(input) {
    const instruction = normalizeInstruction(input);
    const hash = hashInstruction(instruction);
    const existing = this.instructions.get(instruction.id);
    if (existing) {
      if (existing.hash !== hash) {
        throw new LedgerError(
          'conflicting-instruction',
          `instruction ${instruction.id} already exists with different content`,
        );
      }
      return existing;
    }
    const record = { ...instruction, hash };
    this.instructions.set(instruction.id, record);
    this.order.push(instruction.id);
    return record;
  }

  cancel(input) {
    if (!isPlainObject(input) || !isNonEmptyString(input.id)) {
      throw new LedgerError('invalid-event', 'cancel event requires an instruction id');
    }
    const { id, hash } = input;
    const instruction = this.instructions.get(id);
    if (!instruction) {
      throw new LedgerError('unknown-instruction', `unknown instruction: ${id}`);
    }
    if (hash !== undefined && hash !== instruction.hash) {
      throw new LedgerError(
        'hash-mismatch',
        `observed hash does not match instruction ${id}`,
      );
    }
    const existing = this.tombstones.get(id);
    if (existing) {
      return existing;
    }
    const tombstone = { type: 'cancel', id, hash: instruction.hash };
    this.tombstones.set(id, tombstone);
    return tombstone;
  }

  setBudget(input) {
    if (!isPlainObject(input) || !isNonEmptyString(input.party)) {
      throw new LedgerError('invalid-event', 'budget event requires a party');
    }
    const { party, budget } = input;
    if (!isValidAmount(budget) && budget !== 0) {
      throw new LedgerError('invalid-amount', 'budget must be a non-negative finite number');
    }
    this.budgets.set(party, budget);
    return { type: 'budget', party, budget };
  }

  apply(event) {
    if (!isPlainObject(event) || typeof event.type !== 'string') {
      throw new LedgerError('invalid-event', 'event must be an object with a type');
    }
    switch (event.type) {
      case 'instruct':
        return this.instruct(event);
      case 'cancel':
        return this.cancel(event);
      case 'budget':
        return this.setBudget(event);
      default:
        throw new LedgerError('invalid-event', `unknown event type: ${event.type}`);
    }
  }

  merge(events) {
    const list = Array.isArray(events) ? events : events?.events;
    if (!Array.isArray(list)) {
      throw new LedgerError('invalid-event', 'merge expects an array of events');
    }
    return list.map((event) => this.apply(event));
  }

  activeInstructions() {
    return this.order
      .filter((id) => !this.tombstones.has(id))
      .map((id) => this.instructions.get(id));
  }

  net() {
    const totals = new Map();
    for (const instruction of this.activeInstructions()) {
      totals.set(instruction.payer, (totals.get(instruction.payer) ?? 0) + instruction.amount);
      totals.set(instruction.payee, (totals.get(instruction.payee) ?? 0) - instruction.amount);
    }
    return sortedObject(totals.entries());
  }

  certificate() {
    const instructions = this.activeInstructions().map((instruction) => ({ ...instruction }));
    const net = this.net();
    const parties = new Set([...Object.keys(net), ...this.budgets.keys()]);
    const budgets = {};
    let blocked = false;
    for (const party of [...parties].sort()) {
      const budget = this.budgets.has(party) ? this.budgets.get(party) : null;
      const payable = net[party] ?? 0;
      const ok = budget === null || payable <= budget;
      if (!ok) blocked = true;
      budgets[party] = { budget, net: payable, ok };
    }
    return {
      status: blocked ? 'blocked' : 'settled',
      instructions,
      net,
      budgets,
    };
  }

  settle() {
    const cert = this.certificate();
    if (cert.status !== 'settled') {
      throw new LedgerError('budget-exceeded', 'net payable exceeds budget for at least one party');
    }
    return cert;
  }

  toJSON() {
    return {
      instructions: this.order.map((id) => this.instructions.get(id)),
      cancels: [...this.tombstones.values()],
      budgets: Object.fromEntries(this.budgets),
    };
  }

  static fromJSON(state) {
    const ledger = new Ledger({ budgets: state?.budgets ?? {} });
    for (const instruction of state?.instructions ?? []) {
      ledger.instruct(instruction);
    }
    for (const cancel of state?.cancels ?? []) {
      ledger.cancel(cancel);
    }
    return ledger;
  }
}
