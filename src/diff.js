"use strict";

const { MISSING, isMissing, stableStringify } = require("./canon");
const { SnapError } = require("./errors");

// Deep param diff. Missing keys are reported with the MISSING marker, which is
// distinct from an explicit JSON null.
function diffParams(a, b) {
  const changed = [];
  const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  const walk = (x, y, p) => {
    if (isObj(x) && isObj(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const k of keys) {
        const pa = p ? p + "." + k : k;
        const inX = Object.prototype.hasOwnProperty.call(x, k);
        const inY = Object.prototype.hasOwnProperty.call(y, k);
        if (inX && inY) walk(x[k], y[k], pa);
        else {
          changed.push({
            path: pa,
            a: inX ? x[k] : MISSING,
            b: inY ? y[k] : MISSING,
            kind: inX ? "only_a" : "only_b",
          });
        }
      }
      return;
    }
    if (stableStringify(x) !== stableStringify(y)) {
      changed.push({ path: p, a: x === undefined ? MISSING : x, b: y === undefined ? MISSING : y, kind: "changed" });
    }
  };
  walk(a, b, "");
  return changed;
}

function resolveTolerance(tolA, tolB, col, table) {
  const ca = (tolA && tolA[col]) || null;
  const cb = (tolB && tolB[col]) || null;
  if (ca && cb && stableStringify(ca) !== stableStringify(cb)) {
    throw new SnapError("E_TOL", `conflicting tolerance for column "${col}" of table "${table}"`);
  }
  return ca || cb;
}

// Three-valued cell comparison. A numeric mismatch without a declared
// tolerance is "undecided" -- never reported as an inconsistency.
function compareCells(a, b, tol) {
  const ma = isMissing(a);
  const mb = isMissing(b);
  if (ma && mb) return "equal";
  if (ma || mb) return "different";
  if (a === null || b === null) return a === b ? "equal" : "different";
  if (typeof a === "number" && typeof b === "number") {
    if (Object.is(a, b) || a === b) return "equal";
    if (Number.isNaN(a) || Number.isNaN(b)) return "undecided";
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "different";
    const d = Math.abs(a - b);
    if (tol) {
      if (tol.abs !== undefined && d <= tol.abs) return "equal";
      if (tol.rel !== undefined && d <= tol.rel * Math.max(Math.abs(a), Math.abs(b))) return "equal";
      return "different";
    }
    return "undecided";
  }
  return a === b ? "equal" : "different";
}

function sortedKeyStrs(table) {
  return Object.keys(table.rows).sort();
}

// Symmetric difference of one relation across two snapshots, keyed by the
// declared primary key.
function diffTable(snapA, snapB, name) {
  const ta = snapA.tables[name];
  const tb = snapB.tables[name];
  if (!ta && !tb) return null;
  if (!ta) {
    return { only_a: [], only_b: sortedKeyStrs(tb).map((k) => tb.rows[k].keyCells), changed: [], undecided: [] };
  }
  if (!tb) {
    return { only_a: sortedKeyStrs(ta).map((k) => ta.rows[k].keyCells), only_b: [], changed: [], undecided: [] };
  }
  if (stableStringify(ta.key) !== stableStringify(tb.key)) {
    throw new SnapError("E_SNAP", `primary key mismatch for table "${name}" between snapshots`);
  }
  const columns = [...new Set([...ta.columns, ...tb.columns])];
  const onlyA = [];
  const onlyB = [];
  const changed = [];
  const undecided = [];
  const keyStrs = [...new Set([...Object.keys(ta.rows), ...Object.keys(tb.rows)])].sort();
  for (const keyStr of keyStrs) {
    const ra = ta.rows[keyStr];
    const rb = tb.rows[keyStr];
    if (!ra) {
      onlyB.push(rb.keyCells);
      continue;
    }
    if (!rb) {
      onlyA.push(ra.keyCells);
      continue;
    }
    const cells = {};
    let hasDiff = false;
    let hasUndecided = false;
    for (const col of columns) {
      const va = Object.prototype.hasOwnProperty.call(ra.cells, col) ? ra.cells[col] : MISSING;
      const vb = Object.prototype.hasOwnProperty.call(rb.cells, col) ? rb.cells[col] : MISSING;
      const tol = resolveTolerance(ta.tolerance, tb.tolerance, col, name);
      const verdict = compareCells(va, vb, tol);
      if (verdict === "equal") continue;
      cells[col] = { a: va, b: vb, verdict };
      if (verdict === "different") hasDiff = true;
      else hasUndecided = true;
    }
    if (hasDiff) changed.push({ key: ra.keyCells, cells });
    else if (hasUndecided) undecided.push({ key: ra.keyCells, cells });
  }
  return { only_a: onlyA, only_b: onlyB, changed, undecided };
}

function tableNames(snapA, snapB) {
  return [...new Set([...Object.keys(snapA.tables), ...Object.keys(snapB.tables)])].sort();
}

function summarizeStatus(paramChanges, tables) {
  let different = paramChanges > 0;
  let und = false;
  for (const r of Object.values(tables)) {
    if (r.only_a.length || r.only_b.length || r.changed.length) different = true;
    if (r.undecided.length) und = true;
  }
  return different ? "different" : und ? "undecided" : "equal";
}

function diffSnapshots(snapA, snapB) {
  const paramChanges = diffParams(snapA.params, snapB.params);
  const tables = {};
  for (const name of tableNames(snapA, snapB)) {
    tables[name] = diffTable(snapA, snapB, name);
  }
  return {
    status: summarizeStatus(paramChanges.length, tables),
    params: { changed: paramChanges },
    tables,
  };
}

module.exports = { diffParams, compareCells, diffTable, diffSnapshots, tableNames, summarizeStatus };
