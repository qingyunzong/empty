'use strict';

// Relational algebra core with explicit SQL NULL three-valued semantics.
// NULL is represented as JavaScript null (a missing key is also treated as NULL).

function isNull(value) {
  return value === null || value === undefined;
}

// SQL three-valued logic primitives.
const TRUE = true;
const FALSE = false;
const UNKNOWN = null;

function sqlNot(v) {
  return v === UNKNOWN ? UNKNOWN : !v;
}

function sqlAnd(a, b) {
  if (a === FALSE || b === FALSE) return FALSE;
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  return TRUE;
}

function sqlOr(a, b) {
  if (a === TRUE || b === TRUE) return TRUE;
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  return FALSE;
}

// SQL equality: NULL = NULL is UNKNOWN, not equal.
function sqlEq(a, b) {
  if (isNull(a) || isNull(b)) return UNKNOWN;
  return a === b ? TRUE : FALSE;
}

// select: WHERE semantics — a row passes only when the predicate is TRUE;
// UNKNOWN (NULL) and FALSE are both filtered out.
function select(rows, pred) {
  return rows.filter((r) => pred(r) === TRUE);
}

// project: pick the given columns; missing keys become NULL.
function project(rows, cols) {
  return rows.map((r) => {
    const out = {};
    for (const c of cols) out[c] = c in r ? r[c] : null;
    return out;
  });
}

// Set-ops key: SQL set operations (UNION/EXCEPT) treat NULL = NULL as equal.
function rowKey(row) {
  const keys = Object.keys(row).sort();
  return JSON.stringify(keys.map((k) => [k, isNull(row[k]) ? null : row[k]]));
}

// union: set union with duplicate elimination (NULLs deduplicate together).
function union(a, b) {
  const seen = new Set();
  const out = [];
  for (const r of [...a, ...b]) {
    const k = rowKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

// except: rows of a not present in b (set semantics, NULL matches NULL).
function except(a, b) {
  const bKeys = new Set(b.map(rowKey));
  const seen = new Set();
  const out = [];
  for (const r of a) {
    const k = rowKey(r);
    if (!bKeys.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

// join: equijoin on the given attributes; NULL keys never match anything.
function join(left, right, on) {
  const index = new Map();
  for (const r of right) {
    const k = joinKey(r, on);
    if (k === null) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(r);
  }
  const out = [];
  for (const l of left) {
    const k = joinKey(l, on);
    if (k === null) continue;
    const matches = index.get(k);
    if (!matches) continue;
    for (const m of matches) out.push(mergeRows(l, m, on));
  }
  return out;
}

function joinKey(row, on) {
  const parts = [];
  for (const c of on) {
    const v = row[c];
    if (isNull(v)) return null; // NULL never joins
    parts.push([c, v]);
  }
  return JSON.stringify(parts);
}

function mergeRows(l, r, on) {
  const out = { ...l };
  for (const k of Object.keys(r)) {
    if (on.includes(k)) continue;
    if (k in l && r[k] !== l[k]) out[`r_${k}`] = r[k];
    else if (!(k in out)) out[k] = r[k];
  }
  return out;
}

// Aggregates. NULLs are ignored by sum/avg/count(col); a group whose values
// are all NULL has sum/avg = NULL (never coerced to 0). count(*) counts rows.
function sum(rows, col) {
  let acc = 0;
  let seen = false;
  for (const r of rows) {
    const v = r[col];
    if (isNull(v)) continue;
    acc += v;
    seen = true;
  }
  return seen ? acc : null;
}

function count(rows, col) {
  if (col === undefined || col === null) return rows.length;
  let n = 0;
  for (const r of rows) if (!isNull(r[col])) n += 1;
  return n;
}

function avg(rows, col) {
  let sumAcc = 0;
  let n = 0;
  for (const r of rows) {
    const v = r[col];
    if (isNull(v)) continue;
    sumAcc += v;
    n += 1;
  }
  return n === 0 ? null : sumAcc / n;
}

// groupBy: groups rows by the given columns; NULL keys group together
// (SQL GROUP BY treats NULLs as one group).
function groupBy(rows, cols) {
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify(cols.map((c) => (isNull(r[c]) ? null : r[c])));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// aggregate: group rows by groupCols, then apply aggregates
// [{ fn: 'sum'|'count'|'avg', col, as }] per group.
function aggregate(rows, groupCols, aggs) {
  const groups = groupBy(rows, groupCols);
  const out = [];
  for (const gRows of groups.values()) {
    const row = {};
    for (const c of groupCols) row[c] = c in gRows[0] ? gRows[0][c] : null;
    for (const a of aggs) {
      if (a.fn === 'sum') row[a.as] = sum(gRows, a.col);
      else if (a.fn === 'count') row[a.as] = count(gRows, a.col);
      else if (a.fn === 'avg') row[a.as] = avg(gRows, a.col);
      else throw new Error(`unknown aggregate fn: ${a.fn}`);
    }
    out.push(row);
  }
  return out;
}

module.exports = {
  isNull,
  TRUE,
  FALSE,
  UNKNOWN,
  sqlNot,
  sqlAnd,
  sqlOr,
  sqlEq,
  select,
  project,
  union,
  except,
  join,
  groupBy,
  aggregate,
  sum,
  count,
  avg,
  rowKey,
};
