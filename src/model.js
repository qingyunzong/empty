// Pure domain model: hierarchical settlement groups, state machine, budget math.
// No I/O here; persistence and WAL live in store.js / ledger.js.

export const STATES = Object.freeze(['OPEN', 'PREPARED', 'SETTLED', 'CANCELLED', 'PARTIAL']);

// Reference state machine. Terminal states: SETTLED, CANCELLED.
// PARTIAL = cancel was blocked by independently SETTLED descendants.
export const TRANSITIONS = Object.freeze({
  prepare: Object.freeze({ from: Object.freeze(['OPEN']), to: Object.freeze(['PREPARED']) }),
  commit: Object.freeze({ from: Object.freeze(['PREPARED']), to: Object.freeze(['SETTLED']) }),
  cancel: Object.freeze({
    from: Object.freeze(['OPEN', 'PREPARED', 'PARTIAL']),
    to: Object.freeze(['CANCELLED', 'PARTIAL']),
  }),
});

export class ModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

export function emptyState() {
  return { groups: {} };
}

export function available(group) {
  return group.amount - group.reserved - group.spent;
}

export function getGroup(state, id) {
  const group = state.groups[id];
  if (!group) throw new ModelError('NOT_FOUND', `group "${id}" not found`);
  return group;
}

export function childrenOf(state, id) {
  return Object.values(state.groups).filter((g) => g.parentId === id);
}

export function subtreeIds(state, id) {
  const ids = [];
  const walk = (gid) => {
    ids.push(gid);
    for (const child of childrenOf(state, gid)) walk(child.id);
  };
  walk(id);
  return ids;
}

export function createGroup(state, { id, parentId = null, amount }) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new ModelError('INVALID_ID', 'group id must be a non-empty string');
  }
  if (state.groups[id]) throw new ModelError('DUPLICATE_ID', `group "${id}" already exists`);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ModelError('INVALID_AMOUNT', `budget must be a positive number, got ${amount}`);
  }
  let parent = null;
  if (parentId != null) {
    parent = state.groups[parentId];
    if (!parent) throw new ModelError('PARENT_NOT_FOUND', `parent group "${parentId}" not found`);
    if (parent.state === 'CANCELLED' || parent.state === 'SETTLED') {
      throw new ModelError('PARENT_CLOSED', `cannot reserve under a ${parent.state} parent`);
    }
    if (available(parent) < amount) {
      throw new ModelError(
        'INSUFFICIENT_BUDGET',
        `parent "${parentId}" has ${available(parent)} available, requested ${amount}`,
      );
    }
  }
  const group = { id, parentId: parentId ?? null, amount, state: 'OPEN', reserved: 0, spent: 0 };
  state.groups[id] = group;
  if (parent) parent.reserved += amount;
  return group;
}

export function assertPreparable(state, id) {
  const group = getGroup(state, id);
  if (group.state !== 'OPEN') {
    throw new ModelError('INVALID_TRANSITION', `cannot prepare group "${id}" in state ${group.state}`);
  }
  return group;
}

export function prepare(state, id) {
  const group = assertPreparable(state, id);
  group.state = 'PREPARED';
  return group;
}

export function assertCommittable(state, id) {
  const group = getGroup(state, id);
  if (group.state !== 'PREPARED') {
    throw new ModelError('INVALID_TRANSITION', `cannot commit group "${id}" in state ${group.state}`);
  }
  return group;
}

// Budget effect of settling this group: its reservation at the parent
// converts into spent (consumed) budget. Recorded in the WAL PREPARE record.
export function commitImpact(state, id) {
  const group = getGroup(state, id);
  return {
    groupId: id,
    parentId: group.parentId,
    amount: group.amount,
    reservedDelta: group.parentId ? -group.amount : 0,
    spentDelta: group.parentId ? group.amount : 0,
  };
}

export function applyCommit(state, id) {
  const group = assertCommittable(state, id);
  group.state = 'SETTLED';
  if (group.parentId) {
    const parent = state.groups[group.parentId];
    parent.reserved -= group.amount;
    parent.spent += group.amount;
  }
  return group;
}

export function assertCancellable(state, id) {
  const group = getGroup(state, id);
  if (group.state === 'SETTLED') {
    throw new ModelError('INVALID_TRANSITION', `cannot cancel group "${id}": already SETTLED`);
  }
  if (group.state === 'CANCELLED') {
    throw new ModelError('INVALID_TRANSITION', `cannot cancel group "${id}": already CANCELLED`);
  }
  return group;
}

// Revoke a group, cascading to descendants that are not independently SETTLED.
// SETTLED descendants are preserved and reported as blockers; any ancestor on
// a blocked path becomes PARTIAL instead of CANCELLED. Cancelled groups return
// their reserved budget to their parent.
export function applyCancel(state, id) {
  const root = assertCancellable(state, id);
  const blocked = [];
  const cancelled = [];
  let budgetReturned = 0;

  const visit = (node) => {
    for (const child of childrenOf(state, node.id)) visit(child);
    if (node.state === 'SETTLED') {
      blocked.push({
        id: node.id,
        state: node.state,
        reason: `group "${node.id}" is independently SETTLED and must be preserved`,
      });
      return;
    }
    if (node.state === 'CANCELLED') return;
    const hasBlocker = childrenOf(state, node.id).some(
      (child) => child.state === 'SETTLED' || child.state === 'PARTIAL',
    );
    if (hasBlocker) {
      node.state = 'PARTIAL';
      return;
    }
    node.state = 'CANCELLED';
    cancelled.push(node.id);
    if (node.parentId) {
      state.groups[node.parentId].reserved -= node.amount;
      budgetReturned += node.amount;
    }
  };
  visit(root);

  return {
    id,
    status: root.state, // CANCELLED or PARTIAL — never a hard failure
    state: root.state,
    cancelled,
    blocked,
    budgetReturned,
  };
}

// Structural + budget invariants, checked after every mutation and in tests:
// reserved == sum of OPEN/PREPARED/PARTIAL children amounts,
// spent == sum of SETTLED children amounts, available >= 0.
export function assertInvariants(state) {
  for (const group of Object.values(state.groups)) {
    if (!STATES.includes(group.state)) {
      throw new ModelError('INVARIANT_VIOLATION', `group "${group.id}" has unknown state ${group.state}`);
    }
    const kids = childrenOf(state, group.id);
    const expectedReserved = kids
      .filter((k) => k.state === 'OPEN' || k.state === 'PREPARED' || k.state === 'PARTIAL')
      .reduce((sum, k) => sum + k.amount, 0);
    const expectedSpent = kids
      .filter((k) => k.state === 'SETTLED')
      .reduce((sum, k) => sum + k.amount, 0);
    if (group.reserved !== expectedReserved || group.spent !== expectedSpent) {
      throw new ModelError(
        'INVARIANT_VIOLATION',
        `group "${group.id}": reserved=${group.reserved} (want ${expectedReserved}), spent=${group.spent} (want ${expectedSpent})`,
      );
    }
    if (available(group) < 0) {
      throw new ModelError('INVARIANT_VIOLATION', `group "${group.id}" is over-reserved`);
    }
  }
}
