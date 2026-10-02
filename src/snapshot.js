import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCsv } from './csv.js';
import { typeCell, encodeCell, validateTolerance } from './normalize.js';
import { fail } from './errors.js';

export function normJson(value) {
  if (Array.isArray(value)) return value.map(normJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normJson(value[k])]));
  }
  return value;
}

export function computeHash(snap) {
  const payload = JSON.stringify({ params: snap.params, schema: snap.schema, tables: snap.tables });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function normalizeSchema(raw) {
  const tables = {};
  for (const [name, meta] of Object.entries(raw?.tables ?? {})) {
    const key = meta.key == null ? [] : (Array.isArray(meta.key) ? meta.key : [meta.key]);
    tables[name] = {
      key,
      dependsOn: Array.isArray(meta.dependsOn) ? meta.dependsOn : [],
      refs: meta.refs && typeof meta.refs === 'object' ? meta.refs : {},
    };
  }
  return { tables };
}

export function buildSnapshot(runDir, name) {
  const paramsPath = path.join(runDir, 'params.json');
  let params;
  try {
    params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
  } catch (e) {
    fail('E_SNAP', `cannot read params.json in ${runDir}: ${e.message}`);
  }
  let rawSchema = {};
  const schemaPath = path.join(runDir, 'schema.json');
  if (fs.existsSync(schemaPath)) {
    try {
      rawSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } catch (e) {
      fail('E_SNAP', `cannot parse schema.json in ${runDir}: ${e.message}`);
    }
  }
  const tolerance = validateTolerance(rawSchema.tolerance);
  const schema = normalizeSchema(rawSchema);
  const tables = {};
  const dataDir = path.join(runDir, 'data');
  if (fs.existsSync(dataDir)) {
    for (const file of fs.readdirSync(dataDir).sort()) {
      if (!file.endsWith('.csv')) continue;
      const tname = file.slice(0, -4);
      let parsed;
      try {
        parsed = parseCsv(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      } catch (e) {
        fail('E_SNAP', `cannot parse ${file}: ${e.message}`);
      }
      if (parsed.length === 0) {
        tables[tname] = { columns: [], key: schema.tables[tname]?.key ?? [], rows: [] };
        continue;
      }
      const columns = parsed[0];
      const rows = parsed.slice(1).map((r) =>
        columns.map((_, i) => (r[i] === undefined ? 'N' : encodeCell(typeCell(r[i])))));
      rows.sort((x, y) => {
        const sx = x.join('');
        const sy = y.join('');
        return sx < sy ? -1 : sx > sy ? 1 : 0;
      });
      tables[tname] = { columns, key: schema.tables[tname]?.key ?? [], rows };
    }
  }
  const snap = {
    version: 1,
    name,
    createdAt: new Date().toISOString(),
    params: normJson(params),
    tolerance,
    schema,
    tables,
  };
  snap.hash = computeHash(snap);
  return snap;
}
