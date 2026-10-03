"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SnapError } = require("./errors");

// schema.json shape:
// {
//   "tables": {
//     "<table>": {
//       "key": ["id"],                          primary key columns (required)
//       "types": { "col": "number" | "string" }, optional, inferred otherwise
//       "tolerance": { "col": 1e-9 | { "abs": x, "rel": y } },
//       "refs": { "col": "otherTable.keyCol" }  foreign-key edges for the causal graph
//     }
//   },
//   "deps": { "optimizer.lr": ["metrics"] }     param path (prefix) -> affected tables
// }
function loadSchema(runDir) {
  const file = path.join(runDir, "schema.json");
  if (!fs.existsSync(file)) return { tables: {}, deps: {} };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new SnapError("E_SNAP", `invalid schema.json in ${runDir}: ${err.message}`);
  }
  const schema = { tables: raw.tables || {}, deps: raw.deps || {} };
  for (const [table, ts] of Object.entries(schema.tables)) {
    for (const [col, spec] of Object.entries(ts.tolerance || {})) {
      normalizeTolerance(spec, `table "${table}" column "${col}"`);
    }
  }
  return schema;
}

function normalizeTolerance(spec, where) {
  let t = spec;
  if (typeof spec === "number") t = { abs: spec };
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    throw new SnapError("E_TOL", `invalid tolerance at ${where}: expected number or { "abs" | "rel" }`);
  }
  const out = {};
  for (const kind of ["abs", "rel"]) {
    if (t[kind] === undefined) continue;
    if (typeof t[kind] !== "number" || !Number.isFinite(t[kind]) || t[kind] < 0) {
      throw new SnapError("E_TOL", `invalid ${kind} tolerance at ${where}: must be a finite number >= 0`);
    }
    out[kind] = t[kind];
  }
  if (out.abs === undefined && out.rel === undefined) {
    throw new SnapError("E_TOL", `empty tolerance at ${where}: specify "abs" and/or "rel"`);
  }
  return out;
}

module.exports = { loadSchema, normalizeTolerance };
