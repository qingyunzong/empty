// Relational algebra over arrays of plain objects.
// SQL NULL is represented as JavaScript null. Three-valued logic:
// comparisons with NULL yield UNKNOWN (null in JS), the select operator
// keeps only rows whose predicate is TRUE, and aggregates ignore NULLs
// (sum of an all-NULL group is NULL, never 0).

export function isNull(v) {
  return v === null || v === undefined;
}

// SQL three-valued comparison: returns true/false/null (UNKNOWN).
export function cmp3(a, b) {
  if (isNull(a) || isNull(b)) return null;
  if (a === b) return true;
  return false;
}

export function lt3(a, b) {
  if (isNull(a) || isNull(b)) return null;
  return a < b ? true : (a > b ? false : true);
}

// select: keep rows where pred(row) === true (NULL/false filtered out).
export function select(rows, pred) {
  return rows.filter((r) => pred(r) === true);
}

// project: pick fields (or derive via fn). NULLs preserved.
export function project(rows, fields) {
  if (typeof fields === 'function') return rows.map(fields);
  return rows.map((r) => {
    const out = {};
    for (const f of fields) out[f] = isNull(r[f]) ? null : r[f];
    return out;
  });
}

function keyOf(row, fields) {
  return JSON.stringify(fields.map((f) => (isNull(row[f]) ? null : row[f])));
}

// inner join on equality of the given fields; NULL keys never match (SQL semantics).
export function join(left, right, leftFields, rightFields = leftFields) {
  const index = new Map();
  for (const r of right) {
    const k = keyOf(r, rightFields);
    if (keyOfNull(r, rightFields)) continue; // NULL keys cannot match
    index.set(k, [...(index.get(k) || []), r]);
  }
  const out = [];
  for (const l of left) {
    if (keyOfNull(l, leftFields)) continue;
    const k = keyOf(l, leftFields);
    const matches = index.get(k);
    if (!matches) continue;
    for (const r of matches) out.push({ ...l, ...r });
  }
  return out;
}

function keyOfNull(row, fields) {
  return fields.some((f) => isNull(row[f]));
}

function rowKey(row) {
  return canonicalRow(row);
}

function canonicalRow(row) {
  const keys = Object.keys(row).sort();
  return JSON.stringify(keys.map((k) => [k, isNull(row[k]) ? null : row[k]]));
}

// set union (deduplicated).
export function union(a, b) {
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

// set difference: rows of a not present in b (deduplicated).
export function except(a, b) {
  const excluded = new Set(b.map(rowKey));
  const seen = new Set();
  const out = [];
  for (const r of a) {
    const k = rowKey(r);
    if (!excluded.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

// Aggregates. NULLs are ignored; empty/all-NULL input yields NULL
// (except count, which counts rows or non-NULL values).
export function sumAgg(values) {
  let acc = 0;
  let seen = false;
  for (const v of values) {
    if (isNull(v)) continue;
    acc += v;
    seen = true;
  }
  return seen ? acc : null;
}

export function countAgg(values) {
  if (values === null) return 0; // count(*) handled by groupBy
  let n = 0;
  for (const v of values) if (!isNull(v)) n += 1;
  return n;
}

export function avgAgg(values) {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (isNull(v)) continue;
    sum += v;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

const AGGREGATES = { sum: sumAgg, count: countAgg, avg: avgAgg };

// groupBy(rows, fields).agg({ outField: { op: 'sum'|'count'|'avg', field }, ... })
// Fields with NULL keys form their own group (SQL GROUP BY treats NULLs as one group).
export function groupBy(rows, fields) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r, fields);
    let g = groups.get(k);
    if (!g) {
      const keyVals = {};
      for (const f of fields) keyVals[f] = isNull(r[f]) ? null : r[f];
      g = { key: keyVals, rows: [] };
      groups.set(k, g);
    }
    g.rows.push(r);
  }
  return {
    agg(spec) {
      const out = [];
      for (const g of groups.values()) {
        const row = { ...g.key };
        for (const [outField, specEntry] of Object.entries(spec)) {
          const { op, field } = specEntry;
          if (op === 'count' && field === '*') {
            row[outField] = g.rows.length;
            continue;
          }
          const values = g.rows.map((r) => (isNull(r[field]) ? null : r[field]));
          row[outField] = AGGREGATES[op](values);
        }
        out.push(row);
      }
      return out;
    },
  };
}
