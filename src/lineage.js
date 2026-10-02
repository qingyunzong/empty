'use strict';
// 质量批次谱系追溯核心库：递归关系代数闭包、阻塞判定、事务化更正与撤销、证书生成。
const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function normalizeEdge(e) {
  return { child: e.child, parent: e.parent, quantity: e.quantity };
}

function normalizeInspection(i) {
  return { lot: i.lot, result: i.result === undefined ? null : i.result, ts: i.ts };
}

const edgeKey = (e) => canonical(normalizeEdge(e));
const inspectionKey = (i) => canonical(normalizeInspection(i));

function emptyState() {
  return { version: 0, edges: [], inspections: [], transactions: [] };
}

function inputHash(state) {
  const payload = {
    edges: state.edges.map(normalizeEdge).map(canonical).sort(),
    inspections: state.inspections.map(normalizeInspection).map(canonical).sort(),
  };
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}

// ---- 递归关系代数：上游/下游闭包 ----
// upstream(lot) = {lot} ∪ ⋃ upstream(parent) ，对每条 (child=lot, parent) 边递归。
function upstreamClosure(edges, lot, acc = new Set()) {
  if (acc.has(lot)) return acc; // 环保护
  acc.add(lot);
  for (const e of edges) {
    if (e.child === lot) upstreamClosure(edges, e.parent, acc);
  }
  return acc;
}

// downstream(lot) = {lot} ∪ ⋃ downstream(child) ，对每条 (child, parent=lot) 边递归。
function downstreamClosure(edges, lot, acc = new Set()) {
  if (acc.has(lot)) return acc;
  acc.add(lot);
  for (const e of edges) {
    if (e.parent === lot) downstreamClosure(edges, e.child, acc);
  }
  return acc;
}

function rootsOf(edges, upstreamSet) {
  return [...upstreamSet]
    .filter((lot) => !edges.some((e) => e.child === lot && upstreamSet.has(e.parent)))
    .sort();
}

function leavesOf(edges, downstreamSet) {
  return [...downstreamSet]
    .filter((lot) => !edges.some((e) => e.parent === lot && downstreamSet.has(e.child)))
    .sort();
}

// 每个 lot 的生效检验记录：取 ts 最大者；result 为 null 或缺失均视为未检。
function effectiveInspections(inspections) {
  const byLot = new Map();
  for (const raw of inspections) {
    const rec = normalizeInspection(raw);
    const prev = byLot.get(rec.lot);
    if (!prev || rec.ts >= prev.ts) byLot.set(rec.lot, rec);
  }
  return byLot;
}

function isUninspected(effective, lot) {
  const rec = effective.get(lot);
  return !rec || rec.result === null;
}

// 证书：根集合、阻塞记录集合、输入哈希、状态。
// blocked 当且仅当自身或任一上游存在 block 记录；
// 否则若闭包内存在未检（null 或缺失）批次则为 uninspected；全部 pass 才是 passed。
function certificate(state, lot) {
  const up = upstreamClosure(state.edges, lot);
  const down = downstreamClosure(state.edges, lot);
  const blockedRecords = state.inspections
    .map(normalizeInspection)
    .filter((i) => i.result === 'block' && up.has(i.lot))
    .sort((a, b) => a.lot.localeCompare(b.lot) || a.ts - b.ts);
  const effective = effectiveInspections(state.inspections);
  const hasUninspected = [...up].some((l) => isUninspected(effective, l));
  const status = blockedRecords.length > 0 ? 'blocked'
    : hasUninspected ? 'uninspected' : 'passed';
  return {
    lot,
    version: state.version,
    status,
    roots: rootsOf(state.edges, up),
    leaves: leavesOf(state.edges, down),
    upstream: [...up].sort(),
    downstream: [...down].sort(),
    blockedRecords,
    inputHash: inputHash(state),
  };
}

// ---- 事务化更正与撤销 ----
function applyCorrection(state, corr, direction) {
  const [rem, add] = direction === 'apply' ? [corr.old, corr.new] : [corr.new, corr.old];
  if (corr.kind === 'edge') {
    if (rem) {
      const k = edgeKey(rem);
      const idx = state.edges.findIndex((e) => edgeKey(e) === k);
      if (idx === -1) throw new Error('correction old edge not found: ' + k);
      state.edges.splice(idx, 1);
    }
    if (add) state.edges.push(normalizeEdge(add));
  } else if (corr.kind === 'inspection') {
    if (rem) {
      const k = inspectionKey(rem);
      const idx = state.inspections.findIndex((i) => inspectionKey(i) === k);
      if (idx === -1) throw new Error('correction old inspection not found: ' + k);
      state.inspections.splice(idx, 1);
    }
    if (add) state.inspections.push(normalizeInspection(add));
  } else {
    throw new Error('unknown correction kind: ' + corr.kind);
  }
}

function commit(state, tx) {
  if (!tx || typeof tx.id !== 'string' || !Array.isArray(tx.corrections)) {
    throw new Error('transaction must have string id and corrections array');
  }
  if (state.transactions.some((t) => t.id === tx.id)) {
    throw new Error('duplicate transaction id: ' + tx.id);
  }
  for (const corr of tx.corrections) applyCorrection(state, corr, 'apply');
  state.transactions.push({ id: tx.id, corrections: tx.corrections, undone: false });
  state.version += 1;
  return state.version;
}

function undo(state, txId) {
  const tx = state.transactions.find((t) => t.id === txId);
  if (!tx) throw new Error('transaction not found: ' + txId);
  if (tx.undone) return { changed: false, version: state.version }; // 重复撤销：幂等，不改状态
  for (const corr of [...tx.corrections].reverse()) applyCorrection(state, corr, 'revert');
  tx.undone = true;
  state.version += 1;
  return { changed: true, version: state.version };
}

module.exports = {
  canonical,
  emptyState,
  inputHash,
  upstreamClosure,
  downstreamClosure,
  rootsOf,
  leavesOf,
  effectiveInspections,
  certificate,
  commit,
  undo,
};
