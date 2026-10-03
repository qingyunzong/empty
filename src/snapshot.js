"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SnapError } = require("./errors");
const { MISSING, isMissing, stableStringify, sha256 } = require("./canon");
const { parseTable } = require("./csv");
const { loadSchema, normalizeTolerance } = require("./schema");

const SNAP_DIR = ".snap";
const NULL_LITERAL = "\\N";
const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?(?:NaN|Infinity)$/;

function snapDir(runDir) {
  return path.join(runDir, SNAP_DIR);
}
function snapshotPath(runDir) {
  return path.join(snapDir(runDir), "snapshot.json");
}
function paramsPath(runDir) {
  return path.join(runDir, "params.json");
}

function readParams(runDir) {
  if (!fs.existsSync(paramsPath(runDir))) {
    throw new SnapError("E_SNAP", `missing params.json in ${runDir}`);
  }
  try {
    return JSON.parse(fs.readFileSync(paramsPath(runDir), "utf8"));
  } catch (err) {
    throw new SnapError("E_SNAP", `invalid params.json in ${runDir}: ${err.message}`);
  }
}

function paramsHash(params) {
  return sha256(stableStringify(params));
}

function normalizeCell(raw, type, table, col) {
  if (raw === NULL_LITERAL) return null;
  if (type === "number") {
    if (!NUM_RE.test(raw)) {
      throw new SnapError("E_SNAP", `invalid number "${raw}" in ${table}.${col}`);
    }
    return Number(raw);
  }
  return raw;
}

function inferTypes(header, rows, declared, table) {
  const types = {};
  for (let c = 0; c < header.length; c++) {
    const col = header[c];
    if (declared[col] !== undefined) {
      if (declared[col] !== "number" && declared[col] !== "string") {
        throw new SnapError("E_SNAP", `invalid declared type for ${table}.${col}: ${declared[col]}`);
      }
      types[col] = declared[col];
      continue;
    }
    let numeric = true;
    let seenAny = false;
    for (const raw of rows) {
      if (c >= raw.length) continue; // missing cell
      const v = raw[c];
      if (v === NULL_LITERAL) continue;
      seenAny = true;
      if (!NUM_RE.test(v)) {
        numeric = false;
        break;
      }
    }
    types[col] = numeric && seenAny ? "number" : "string";
  }
  return types;
}

// Row hash: numbers in columns with an absolute tolerance are quantized so
// that tolerance-equal rows share a hash; everything else is exact.
function rowHash(cells, columns, tolerance) {
  const q = {};
  for (const col of columns) {
    let v = cells[col];
    const t = tolerance[col];
    if (typeof v === "number" && t && t.abs > 0 && Number.isFinite(v)) {
      v = Math.round(v / t.abs);
    }
    q[col] = v;
  }
  return sha256(stableStringify(q));
}

function normalizeTable(name, text, tschema) {
  const { header, rows } = parseTable(text);
  const seen = new Set();
  for (const h of header) {
    if (seen.has(h)) throw new SnapError("E_SNAP", `duplicate column "${h}" in table "${name}"`);
    seen.add(h);
  }
  const key = tschema.key;
  if (!Array.isArray(key) || key.length === 0) {
    throw new SnapError("E_NO_KEY", `table "${name}" has no primary key; declare "key" in schema.json`);
  }
  for (const kc of key) {
    if (!header.includes(kc)) {
      throw new SnapError("E_NO_KEY", `key column "${kc}" not found in table "${name}"`);
    }
  }
  const types = inferTypes(header, rows, tschema.types || {}, name);
  const tolerance = {};
  for (const [col, spec] of Object.entries(tschema.tolerance || {})) {
    if (!header.includes(col)) {
      throw new SnapError("E_TOL", `tolerance declared for unknown column "${col}" of table "${name}"`);
    }
    tolerance[col] = normalizeTolerance(spec, `table "${name}" column "${col}"`);
  }
  const outRows = {};
  for (const raw of rows) {
    if (raw.length > header.length) {
      throw new SnapError(
        "E_SNAP",
        `table "${name}" row has ${raw.length} cells but header has ${header.length} columns`
      );
    }
    const cells = {};
    for (let c = 0; c < header.length; c++) {
      cells[header[c]] = c < raw.length ? normalizeCell(raw[c], types[header[c]], name, header[c]) : MISSING;
    }
    const keyCells = key.map((kc) => cells[kc]);
    if (keyCells.some((v) => v === null || isMissing(v))) {
      throw new SnapError("E_NO_KEY", `null or missing primary key in table "${name}"`);
    }
    const keyStr = stableStringify(keyCells);
    if (outRows[keyStr]) {
      throw new SnapError("E_SNAP", `duplicate primary key ${keyStr} in table "${name}"`);
    }
    outRows[keyStr] = { keyCells, cells, hash: rowHash(cells, header, tolerance) };
  }
  const sortedRows = {};
  for (const k of Object.keys(outRows).sort()) sortedRows[k] = outRows[k];
  const hash = sha256(
    stableStringify({
      key,
      columns: header,
      types,
      rows: Object.keys(sortedRows).map((k) => [k, sortedRows[k].hash]),
    })
  );
  return { key, columns: header, types, tolerance, hash, rows: sortedRows };
}

function buildSnapshot(runDir) {
  const params = readParams(runDir);
  const schema = loadSchema(runDir);
  const dataDir = path.join(runDir, "data");
  const tables = {};
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir).filter((f) => f.endsWith(".csv")).sort()) {
      const name = f.slice(0, -4);
      const content = fs.readFileSync(path.join(dataDir, f), "utf8");
      const table = normalizeTable(name, content, schema.tables[name] || {});
      table.dataHash = sha256(content);
      tables[name] = table;
    }
  }
  return {
    version: 1,
    tool: "snapdiff",
    createdAt: new Date().toISOString(),
    params,
    paramsHash: paramsHash(params),
    schema,
    tables,
  };
}

function loadSnapshot(runDir) {
  const file = snapshotPath(runDir);
  if (!fs.existsSync(file)) {
    throw new SnapError("E_SNAP", `no snapshot for ${runDir}; run 'snapdiff snap ${runDir}' first`);
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new SnapError("E_SNAP", `corrupt snapshot for ${runDir}: ${err.message}`);
  }
  if (!snap || snap.version !== 1 || typeof snap.tables !== "object" || snap.tables === null) {
    throw new SnapError("E_SNAP", `unsupported or corrupt snapshot for ${runDir}`);
  }
  return snap;
}

module.exports = {
  SNAP_DIR,
  snapDir,
  snapshotPath,
  paramsPath,
  readParams,
  paramsHash,
  buildSnapshot,
  loadSnapshot,
  normalizeTable,
};
