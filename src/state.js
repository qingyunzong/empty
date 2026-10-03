import { BizError } from './errors.js';

const EPS = 1e-9;
export const QC_STATUSES = new Set(['pending', 'passed', 'failed']);

export function emptyState() {
  return { version: 1, seq: 0, prevHash: null, batches: {} };
}

export function getBatch(state, id) {
  const b = state.batches[id];
  if (!b) throw new BizError(`batch not found: ${id}`);
  return b;
}

function checkId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new BizError(`invalid batch id: ${JSON.stringify(id)}`);
}

function checkWeight(w) {
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
    throw new BizError(`invalid weight: ${JSON.stringify(w)}`);
  }
}

export function remainingWeight(state, id) {
  const b = getBatch(state, id);
  const used = b.children.reduce((s, c) => s + c.amount, 0);
  return b.weight - used;
}

export function descendantsOf(state, id) {
  getBatch(state, id);
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = state.batches[stack.pop()];
    for (const c of cur.children) {
      if (!seen.has(c.id)) { seen.add(c.id); stack.push(c.id); }
    }
  }
  return seen;
}

export function ancestorsOf(state, id) {
  getBatch(state, id);
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = state.batches[stack.pop()];
    for (const p of cur.parents) {
      if (!seen.has(p.id)) { seen.add(p.id); stack.push(p.id); }
    }
  }
  return seen;
}

export function addEdge(state, parentId, childId, amount) {
  const parent = getBatch(state, parentId);
  const child = getBatch(state, childId);
  checkWeight(amount);
  if (parentId === childId) throw new BizError(`self link forbidden: ${parentId}`);
  if (descendantsOf(state, childId).has(parentId)) {
    throw new BizError(`cyclic ancestor forbidden: ${parentId} -> ${childId}`);
  }
  if (parent.children.some((c) => c.id === childId)) {
    throw new BizError(`edge already exists: ${parentId} -> ${childId}`);
  }
  if (remainingWeight(state, parentId) + EPS < amount) {
    throw new BizError(
      `weight conservation violated: parent ${parentId} remaining ${remainingWeight(state, parentId)} < ${amount}`);
  }
  parent.children.push({ id: childId, amount });
  child.parents.push({ id: parentId, amount });
}

export function createBatch(state, { id, weight, qc = 'pending' }) {
  checkId(id);
  checkWeight(weight);
  if (!QC_STATUSES.has(qc)) throw new BizError(`invalid qc status: ${qc}`);
  if (state.batches[id]) throw new BizError(`batch already exists: ${id}`);
  state.batches[id] = { id, weight, qc, parents: [], children: [] };
}

export function splitBatch(state, { parent, children }) {
  getBatch(state, parent);
  if (!Array.isArray(children) || children.length === 0) throw new BizError('split needs children');
  const seen = new Set();
  let total = 0;
  for (const c of children) {
    checkId(c.id);
    checkWeight(c.weight);
    if (seen.has(c.id)) throw new BizError(`duplicate child id: ${c.id}`);
    if (state.batches[c.id]) throw new BizError(`batch already exists: ${c.id}`);
    seen.add(c.id);
    total += c.weight;
  }
  if (remainingWeight(state, parent) + EPS < total) {
    throw new BizError(
      `weight conservation violated: split of ${parent} outputs ${total} > remaining ${remainingWeight(state, parent)}`);
  }
  for (const c of children) {
    createBatch(state, { id: c.id, weight: c.weight });
    addEdge(state, parent, c.id, c.weight);
  }
}

export function mergeBatches(state, { parents, child }) {
  if (!Array.isArray(parents) || parents.length === 0) throw new BizError('merge needs parents');
  for (const p of parents) getBatch(state, p);
  checkId(child.id);
  checkWeight(child.weight);
  if (state.batches[child.id]) throw new BizError(`batch already exists: ${child.id}`);
  const available = parents.reduce((s, p) => s + Math.max(0, remainingWeight(state, p)), 0);
  if (available + EPS < child.weight) {
    throw new BizError(
      `weight conservation violated: merge output ${child.weight} > effective parent weight ${available}`);
  }
  createBatch(state, { id: child.id, weight: child.weight });
  let need = child.weight;
  for (const p of parents) {
    if (need <= EPS) break;
    const take = Math.min(Math.max(0, remainingWeight(state, p)), need);
    if (take > EPS) {
      addEdge(state, p, child.id, take);
      need -= take;
    }
  }
}

export function linkBatches(state, { parent, child, amount }) {
  addEdge(state, parent, child, amount);
}

export function setQc(state, { id, status }) {
  if (!QC_STATUSES.has(status)) throw new BizError(`invalid qc status: ${status}`);
  getBatch(state, id).qc = status;
}

export function applyOp(state, op) {
  switch (op.op) {
    case 'create': return createBatch(state, op);
    case 'split': return splitBatch(state, op);
    case 'merge': return mergeBatches(state, op);
    case 'link': return linkBatches(state, op);
    case 'qc': return setQc(state, op);
    default: throw new BizError(`unknown op: ${op.op}`);
  }
}

export function validateState(state) {
  const violations = [];
  for (const b of Object.values(state.batches)) {
    const used = b.children.reduce((s, c) => s + c.amount, 0);
    if (used > b.weight + EPS) {
      violations.push(`weight conservation violated at ${b.id}: outputs ${used} > weight ${b.weight}`);
    }
  }
  const color = new Map();
  const visit = (id, stack) => {
    const c = color.get(id) || 0;
    if (c === 1) { violations.push(`cycle detected: ${[...stack, id].join(' -> ')}`); return; }
    if (c === 2) return;
    color.set(id, 1);
    for (const ch of state.batches[id].children) visit(ch.id, [...stack, id]);
    color.set(id, 2);
  };
  for (const id of Object.keys(state.batches)) visit(id, []);
  return violations;
}
