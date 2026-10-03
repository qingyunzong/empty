"use strict";

const { stableStringify, isMissing } = require("./canon");

const SEP = String.fromCharCode(0);

function rowId(table, keyStr) {
  return table + SEP + keyStr;
}

// Causal dependency graph over primary keys.
// Nodes: "param:<path>" and "<table><SEP><keyStr>".
// Edges: param -> rows of tables it affects (schema.deps, prefix match);
//        referenced row -> referencing rows (schema refs, foreign keys).
// coverage(param) = every row reachable from the param node.
function buildCoverage(snapA, snapB, changedParams) {
  const rowsByTable = new Map();
  for (const snap of [snapB, snapA]) {
    for (const [t, tbl] of Object.entries(snap.tables || {})) {
      if (!rowsByTable.has(t)) rowsByTable.set(t, new Map());
      const m = rowsByTable.get(t);
      for (const [keyStr, row] of Object.entries(tbl.rows)) m.set(keyStr, row);
    }
  }
  const adj = new Map();
  const addEdge = (u, v) => {
    if (!adj.has(u)) adj.set(u, new Set());
    adj.get(u).add(v);
  };
  const deps = { ...(snapA.schema?.deps || {}), ...(snapB.schema?.deps || {}) };
  for (const p of changedParams) {
    const pid = "param:" + p;
    for (const [depKey, tables] of Object.entries(deps)) {
      if (!(p === depKey || p.startsWith(depKey + "."))) continue;
      for (const t of tables) {
        const m = rowsByTable.get(t);
        if (!m) continue;
        for (const keyStr of m.keys()) addEdge(pid, rowId(t, keyStr));
      }
    }
  }
  const tableSchemas = { ...(snapB.schema?.tables || {}), ...(snapA.schema?.tables || {}) };
  for (const [t, ts] of Object.entries(tableSchemas)) {
    const refs = ts.refs || {};
    const m = rowsByTable.get(t);
    if (!m) continue;
    for (const [col, target] of Object.entries(refs)) {
      const dot = target.lastIndexOf(".");
      if (dot <= 0) continue;
      const ut = target.slice(0, dot);
      const um = rowsByTable.get(ut);
      if (!um) continue;
      for (const [keyStr, row] of m) {
        const v = row.cells[col];
        if (v === null || v === undefined || isMissing(v)) continue;
        const targetKey = stableStringify([v]);
        if (um.has(targetKey)) addEdge(rowId(ut, targetKey), rowId(t, keyStr));
      }
    }
  }
  const coverage = new Map();
  for (const p of changedParams) {
    const seen = new Set();
    const queue = ["param:" + p];
    while (queue.length) {
      const u = queue.pop();
      for (const v of adj.get(u) || []) {
        if (!seen.has(v)) {
          seen.add(v);
          queue.push(v);
        }
      }
    }
    coverage.set(p, seen);
  }
  return { coverage };
}

module.exports = { rowId, buildCoverage };
