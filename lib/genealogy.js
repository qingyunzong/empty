'use strict';

// 批次谱系追溯核心库：版本化状态、递归关系代数追溯、事务化更正与撤销、证书生成。
// 仅使用 Node.js 标准库。

const crypto = require('node:crypto');

// ---------- 基础工具 ----------

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeEdge(edge) {
  if (!edge || typeof edge.child !== 'string' || typeof edge.parent !== 'string') {
    throw new Error('edge requires string child and parent');
  }
  if (typeof edge.quantity !== 'number' || !(edge.quantity > 0)) {
    throw new Error('edge requires positive numeric quantity');
  }
  return { child: edge.child, parent: edge.parent, quantity: edge.quantity };
}

function normalizeInspection(rec) {
  if (!rec || typeof rec.lot !== 'string') throw new Error('inspection requires string lot');
  if (rec.result !== null && rec.result !== 'pass' && rec.result !== 'block') {
    throw new Error('inspection result must be pass, block or null');
  }
  if (typeof rec.ts !== 'number') throw new Error('inspection requires numeric ts');
  return { lot: rec.lot, result: rec.result, ts: rec.ts };
}

function edgeKey(edge) {
  return canonical(normalizeEdge(edge));
}

function inspectionKey(rec) {
  return canonical(normalizeInspection(rec));
}

// ---------- 状态 ----------

function createState(data) {
  const state = { version: 0, edges: [], inspections: [], transactions: [] };
  if (data && Array.isArray(data.edges)) state.edges = data.edges.map(normalizeEdge);
  if (data && Array.isArray(data.inspections)) {
    state.inspections = data.inspections.map(normalizeInspection);
  }
  return state;
}

function inputHash(state) {
  const edges = state.edges.map(edgeKey).sort();
  const inspections = state.inspections.map(inspectionKey).sort();
  return crypto.createHash('sha256').update(canonical({ edges, inspections })).digest('hex');
}

// ---------- 递归关系代数：祖先/后代闭包 ----------

function parentsOf(state, lot) {
  return state.edges.filter((e) => e.child === lot).map((e) => e.parent);
}

function childrenOf(state, lot) {
  return state.edges.filter((e) => e.parent === lot).map((e) => e.child);
}

// 递归向上的传递闭包（不含 lot 自身）
function ancestors(state, lot) {
  const seen = new Set();
  const visit = (current) => {
    for (const parent of parentsOf(state, current)) {
      if (!seen.has(parent)) {
        seen.add(parent);
        visit(parent);
      }
    }
  };
  visit(lot);
  return seen;
}

// 递归向下的传递闭包（不含 lot 自身）
function descendants(state, lot) {
  const seen = new Set();
  const visit = (current) => {
    for (const child of childrenOf(state, current)) {
      if (!seen.has(child)) {
        seen.add(child);
        visit(child);
      }
    }
  };
  visit(lot);
  return seen;
}

// 上游根批次：闭包内无父边的批次
function roots(state, lot) {
  const scope = new Set([lot, ...ancestors(state, lot)]);
  return [...scope].filter((l) => parentsOf(state, l).length === 0).sort();
}

// 下游叶批次：闭包内无子边的批次
function leaves(state, lot) {
  const scope = new Set([lot, ...descendants(state, lot)]);
  return [...scope].filter((l) => childrenOf(state, l).length === 0).sort();
}

// ---------- 阻塞与证书 ----------

// 阻塞记录集合：自身或任一批量上游存在的 block 检验记录
function blockedRecords(state, lot) {
  const scope = new Set([lot, ...ancestors(state, lot)]);
  return state.inspections
    .filter((r) => r.result === 'block' && scope.has(r.lot))
    .map(clone)
    .sort((a, b) => inspectionKey(a) < inspectionKey(b) ? -1 : 1);
}

function statusOf(state, lot) {
  const scope = new Set([lot, ...ancestors(state, lot)]);
  const records = state.inspections.filter((r) => scope.has(r.lot));
  if (records.some((r) => r.result === 'block')) return 'blocked';
  // null 或缺失均表示未检，不得隐式判定合格
  if (!records.some((r) => r.result === 'pass')) return 'uninspected';
  return 'pass';
}

function certificate(state, lot) {
  return {
    lot,
    version: state.version,
    status: statusOf(state, lot),
    roots: roots(state, lot),
    leaves: leaves(state, lot),
    blockedRecords: blockedRecords(state, lot),
    inputHash: inputHash(state),
  };
}

// ---------- 事务化更正与撤销 ----------

function removeEdge(state, edge) {
  const key = edgeKey(edge);
  const idx = state.edges.findIndex((e) => edgeKey(e) === key);
  if (idx >= 0) state.edges.splice(idx, 1);
}

function removeInspection(state, rec) {
  const key = inspectionKey(rec);
  const idx = state.inspections.findIndex((r) => inspectionKey(r) === key);
  if (idx >= 0) state.inspections.splice(idx, 1);
}

function applyTx(state, tx) {
  if (tx.kind === 'edge') {
    if (tx.old) removeEdge(state, tx.old);
    if (tx.new) state.edges.push(normalizeEdge(tx.new));
  } else if (tx.kind === 'inspection') {
    if (tx.old) removeInspection(state, tx.old);
    if (tx.new) state.inspections.push(normalizeInspection(tx.new));
  } else {
    throw new Error('unknown transaction kind: ' + tx.kind);
  }
}

function revertTx(state, tx) {
  if (tx.kind === 'edge') {
    if (tx.new) removeEdge(state, tx.new);
    if (tx.old) state.edges.push(normalizeEdge(tx.old));
  } else if (tx.kind === 'inspection') {
    if (tx.new) removeInspection(state, tx.new);
    if (tx.old) state.inspections.push(normalizeInspection(tx.old));
  } else {
    throw new Error('unknown transaction kind: ' + tx.kind);
  }
}

// 提交更正事务，生成新谱系版本。返回新状态对象，不修改入参。
function commit(state, tx) {
  if (!tx || typeof tx.id !== 'string' || tx.id.length === 0) {
    throw new Error('transaction requires non-empty string id');
  }
  if (state.transactions.some((t) => t.id === tx.id && !t.undone)) {
    throw new Error('duplicate active transaction id: ' + tx.id);
  }
  const next = clone(state);
  const record = {
    id: tx.id,
    kind: tx.kind,
    old: tx.old ? clone(tx.old) : null,
    new: tx.new ? clone(tx.new) : null,
    undone: false,
  };
  applyTx(next, record);
  next.transactions.push(record);
  next.version += 1;
  return next;
}

// 按事务 id 撤销。不存在则抛错；已撤销则为幂等空操作，状态不变。
function undo(state, txId) {
  const tx = state.transactions.find((t) => t.id === txId);
  if (!tx) throw new Error('transaction not found: ' + txId);
  if (tx.undone) return { state, changed: false };
  const next = clone(state);
  revertTx(next, tx);
  next.transactions.find((t) => t.id === txId).undone = true;
  next.version += 1;
  return { state: next, changed: true };
}

// ---------- 小规模参考算法：独立 DFS 枚举所有可达节点 ----------

function referenceReachable(state, lot, direction) {
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('direction must be up or down');
  }
  const adjacency = new Map();
  for (const edge of state.edges) {
    const from = direction === 'up' ? edge.child : edge.parent;
    const to = direction === 'up' ? edge.parent : edge.child;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(to);
  }
  const seen = new Set();
  const stack = [lot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const next of adjacency.get(current) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  seen.delete(lot);
  return seen;
}

module.exports = {
  createState,
  inputHash,
  parentsOf,
  childrenOf,
  ancestors,
  descendants,
  roots,
  leaves,
  blockedRecords,
  statusOf,
  certificate,
  commit,
  undo,
  referenceReachable,
  canonical,
};
