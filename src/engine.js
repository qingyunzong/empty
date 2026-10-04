'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('./sql');
const { buildPlan } = require('./plan');
const { optimize } = require('./optimize');
const { bestPlans, toDirect, execResult } = require('./physical');
const { makeCertificate } = require('./verify');
const { E_NON_EQUIV, QError } = require('./errors');
const V = require('./values');

function loadTables(dir) {
  const data = {};
  if (!fs.existsSync(dir)) throw new QError('E_IO', `data directory not found: ${dir}`);
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const name = path.basename(f, '.json');
    const rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!Array.isArray(rows)) throw new QError('E_IO', `${f}: expected a JSON array of row objects`);
    data[name] = rows;
  }
  return data;
}

function schemasFromData(data) {
  const schemas = {};
  for (const [t, rows] of Object.entries(data)) {
    const cols = new Set();
    for (const r of rows.slice(0, 100)) for (const k of Object.keys(r)) cols.add(k);
    schemas[t] = [...cols];
  }
  return schemas;
}

function statsFromData(data) {
  return {
    rowCount: (t) => (data[t] ? data[t].length : 0),
    // Uniqueness of the key among rows whose key is fully non-NULL.
    isUnique: (t, cols) => {
      const seen = new Set();
      for (const r of data[t] || []) {
        const vals = cols.map((c) => r[c]);
        if (vals.some((v) => v === null || v === undefined)) continue;
        const k = vals.map(V.encVal).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    },
    hasNullKey: (t, cols) =>
      (data[t] || []).some((r) => cols.some((c) => r[c] === null || r[c] === undefined)),
    // Every non-NULL key tuple of sTable(sCols) occurs in rTable(rCols).
    keysIncluded: (sTable, sCols, rTable, rCols) => {
      const rset = new Set();
      for (const r of data[rTable] || []) {
        const vals = rCols.map((c) => r[c]);
        if (vals.some((v) => v === null || v === undefined)) continue;
        rset.add(vals.map(V.encVal).join('|'));
      }
      for (const r of data[sTable] || []) {
        const vals = sCols.map((c) => r[c]);
        if (vals.some((v) => v === null || v === undefined)) continue;
        if (!rset.has(vals.map(V.encVal).join('|'))) return false;
      }
      return true;
    },
  };
}

// Parse -> logical plan -> optimize -> enumerate physical plans -> execute the
// (first) min-cost plan, and prove it equal to direct enumeration of the
// unoptimized plan. A mismatch rejects the rewrite with E_NON_EQUIV instead
// of returning an approximate result.
function runQuery(sqlText, data) {
  const ast = parse(sqlText);
  const schemas = schemasFromData(data);
  const logical = buildPlan(ast, schemas);
  const stats = statsFromData(data);
  const { plan: optimized, rules } = optimize(logical, stats);
  const tied = bestPlans(optimized, stats);
  const chosen = tied[0].plan;
  const inputRows = Object.values(data).reduce((a, r) => a + r.length, 0);
  const baseline = execResult(toDirect(logical), data);
  const optRes = execResult(chosen, data);
  const certificate = makeCertificate({ rules, inputRows, baseline, optimized: optRes });
  if (!certificate.equal) {
    throw E_NON_EQUIV(
      `optimized plan differs from direct enumeration ` +
      `(baseline rows=${certificate.baseline.rowsHash.slice(0, 12)}, ` +
      `optimized rows=${certificate.optimized.rowsHash.slice(0, 12)})`
    );
  }
  return {
    rows: optRes.rows,
    unknown: optRes.unknown,
    falseCount: optRes.falseCount,
    certificate,
    logical,
    optimized,
    physical: tied,
  };
}

module.exports = { loadTables, schemasFromData, statsFromData, runQuery };
