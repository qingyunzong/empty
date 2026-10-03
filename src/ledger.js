import { LedgerError } from './errors.js';

export const STATES = ['OPEN', 'PREPARED', 'SETTLED', 'CANCELLED', 'PARTIAL'];

// Allowed state transitions per group state. `cancel` from OPEN lands on
// CANCELLED when no descendant blocks, otherwise PARTIAL.
export const STATE_TRANSITIONS = {
  OPEN: { prepare: 'PREPARED', cancel: ['CANCELLED', 'PARTIAL'] },
  PREPARED: { commit: 'SETTLED', rollback: 'OPEN' },
  SETTLED: {},
  CANCELLED: {},
  PARTIAL: { cancel: ['PARTIAL'] },
};

export function allowedOperations(state) {
  return Object.keys(STATE_TRANSITIONS[state] ?? {});
}

export class Ledger {
  constructor(store) {
    this.store = store;
    this.data = store.load();
  }

  get groups() {
    return this.data.groups;
  }

  mustGet(id) {
    const group = this.groups[id];
    if (!group) throw new LedgerError('GROUP_NOT_FOUND', `group not found: ${id}`, { id });
    return group;
  }

  childrenOf(id) {
    return Object.values(this.groups)
      .filter((group) => group.parentId === id)
      .map((group) => group.id);
  }

  subtreeIds(id) {
    const out = [];
    const walk = (current) => {
      out.push(current);
      for (const child of this.childrenOf(current)) walk(child);
    };
    walk(id);
    return out;
  }

  fundsOf(group) {
    return group.parentId === null ? group.budget : group.amount;
  }

  reservedOf(id) {
    return this.childrenOf(id)
      .filter((child) => this.groups[child].state !== 'CANCELLED')
      .reduce((sum, child) => sum + this.groups[child].amount, 0);
  }

  availableOf(id) {
    const group = this.mustGet(id);
    return this.fundsOf(group) - this.reservedOf(id);
  }

  initRoot(id, budget) {
    if (this.data.rootId) {
      throw new LedgerError('ALREADY_INITIALIZED', `root already exists: ${this.data.rootId}`, {
        rootId: this.data.rootId,
      });
    }
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new LedgerError('INVALID_AMOUNT', 'budget must be a positive number', { budget });
    }
    this.groups[id] = {
      id,
      parentId: null,
      state: 'OPEN',
      budget,
      amount: 0,
      pending: 0,
      settled: 0,
    };
    this.data.rootId = id;
    this.store.save();
    return this.getView(id);
  }

  addGroup(parentId, id, amount) {
    const parent = this.mustGet(parentId);
    if (this.groups[id]) {
      throw new LedgerError('DUPLICATE_GROUP', `group already exists: ${id}`, { id });
    }
    if (parent.state !== 'OPEN') {
      throw new LedgerError('INVALID_STATE', `cannot add child to group in state ${parent.state}`, {
        id: parentId,
        state: parent.state,
      });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new LedgerError('INVALID_AMOUNT', 'amount must be a positive number', { amount });
    }
    const available = this.availableOf(parentId);
    if (amount > available) {
      throw new LedgerError(
        'INSUFFICIENT_BUDGET',
        `requested ${amount} exceeds available budget ${available} of ${parentId}`,
        { id: parentId, requested: amount, available },
      );
    }
    this.groups[id] = { id, parentId, state: 'OPEN', amount, pending: 0, settled: 0 };
    this.store.save();
    return this.getView(id);
  }

  getView(id) {
    const group = this.mustGet(id);
    const view = {
      id: group.id,
      parentId: group.parentId,
      state: group.state,
      reserved: this.reservedOf(id),
      available: this.availableOf(id),
      pending: group.pending ?? 0,
      settled: group.settled ?? 0,
      children: this.childrenOf(id).map((child) => ({
        id: child,
        state: this.groups[child].state,
        amount: this.groups[child].amount,
      })),
    };
    if (group.parentId === null) view.budget = group.budget;
    else view.amount = group.amount;
    return view;
  }

  prepare(id) {
    const group = this.mustGet(id);
    if (group.state !== 'OPEN') {
      throw new LedgerError('INVALID_STATE', `cannot prepare group in state ${group.state}`, {
        id,
        state: group.state,
        allowed: ['OPEN'],
      });
    }
    const subtree = this.subtreeIds(id);
    const inFlight = subtree.filter((other) => other !== id && this.groups[other].state === 'PREPARED');
    if (inFlight.length > 0) {
      throw new LedgerError('COMMIT_IN_FLIGHT', `descendants have a commit in flight: ${inFlight.join(', ')}`, {
        id,
        descendants: inFlight,
      });
    }
    this.data.txSeq += 1;
    const txId = `tx-${this.data.txSeq}`;
    const snapshot = {
      states: Object.fromEntries(subtree.map((other) => [other, this.groups[other].state])),
    };
    const budgetImpact = { parentId: group.parentId, amount: group.amount ?? 0 };
    this.store.appendWal({
      op: 'PREPARE',
      txId,
      groupId: id,
      ts: new Date().toISOString(),
      snapshot,
      budgetImpact,
    });
    group.state = 'PREPARED';
    group.txId = txId;
    if (group.parentId) {
      const parent = this.groups[group.parentId];
      parent.pending = (parent.pending ?? 0) + (group.amount ?? 0);
    }
    this.store.save();
    return { id, txId, state: group.state, budgetImpact };
  }

  commit(id) {
    const group = this.mustGet(id);
    if (group.state !== 'PREPARED') {
      throw new LedgerError('INVALID_STATE', `cannot commit group in state ${group.state}`, {
        id,
        state: group.state,
        allowed: ['PREPARED'],
      });
    }
    const txId = group.txId;
    this.store.appendWal({ op: 'COMMIT', txId, groupId: id, ts: new Date().toISOString() });
    group.state = 'SETTLED';
    delete group.txId;
    if (group.parentId) {
      const parent = this.groups[group.parentId];
      parent.pending = Math.max(0, (parent.pending ?? 0) - (group.amount ?? 0));
      parent.settled = (parent.settled ?? 0) + (group.amount ?? 0);
    }
    this.store.save();
    return { id, txId, state: group.state };
  }

  // Revoke a group: cascade-cancel descendants that are not independently
  // SETTLED. SETTLED (and PARTIAL) descendants are kept and reported as
  // blocking reasons; the target then becomes PARTIAL instead of failing.
  cancel(id) {
    const group = this.mustGet(id);
    if (group.state === 'SETTLED') {
      throw new LedgerError('ALREADY_SETTLED', `cannot cancel settled group: ${id}`, { id });
    }
    if (group.state === 'CANCELLED') {
      throw new LedgerError('ALREADY_CANCELLED', `group already cancelled: ${id}`, { id });
    }
    if (group.state === 'PREPARED') {
      throw new LedgerError('COMMIT_IN_FLIGHT', `cannot cancel group with commit in flight: ${id}`, { id });
    }
    for (const other of this.subtreeIds(id)) {
      if (other !== id && this.groups[other].state === 'PREPARED') {
        throw new LedgerError('COMMIT_IN_FLIGHT', `descendant has a commit in flight: ${other}`, { id: other });
      }
    }
    const cancelled = [];
    const kept = [];
    const blocked = [];
    const visit = (current) => {
      for (const childId of this.childrenOf(current)) {
        const child = this.groups[childId];
        if (child.state === 'SETTLED') {
          kept.push({ id: childId, state: 'SETTLED' });
          blocked.push({
            id: childId,
            reason: 'ALREADY_SETTLED: independently settled, revocation blocked',
          });
        } else if (child.state === 'PARTIAL') {
          kept.push({ id: childId, state: 'PARTIAL' });
          blocked.push({
            id: childId,
            reason: 'PARTIAL_SUBTREE: contains independently settled descendants',
          });
        } else {
          visit(childId);
          child.state = 'CANCELLED';
          cancelled.push(childId);
        }
      }
    };
    visit(id);
    let released = cancelled.reduce((sum, childId) => sum + this.groups[childId].amount, 0);
    if (blocked.length === 0) {
      group.state = 'CANCELLED';
      cancelled.push(id);
      released += group.amount ?? 0;
    } else {
      group.state = 'PARTIAL';
    }
    this.store.save();
    return { id, state: group.state, cancelled, kept, blocked, released };
  }
}
