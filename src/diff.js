import { validateTolerance, compareCells, displayCell } from './normalize.js';
import { fail } from './errors.js';

export function diffParams(a, b, base = '') {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of [...keys].sort()) {
    const p = base ? `${base}.${k}` : k;
    const va = a?.[k];
    const vb = b?.[k];
    const bothObj = va && vb && typeof va === 'object' && typeof vb === 'object'
      && !Array.isArray(va) && !Array.isArray(vb);
    if (bothObj) {
      out.push(...diffParams(va, vb, p));
    } else if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) {
      out.push({ path: p, a: va ?? null, b: vb ?? null });
    }
  }
  return out;
}

function keyOf(row, keyIdx) {
  return keyIdx.map((i) => row[i]).join('');
}

export function diffTables(snapA, snapB, tol) {
  const result = {};
  const names = new Set([...Object.keys(snapA.tables), ...Object.keys(snapB.tables)]);
  for (const t of [...names].sort()) {
    const ta = snapA.tables[t];
    const tb = snapB.tables[t];
    if (!ta || !tb) {
      result[t] = { tableMissing: !ta ? 'a' : 'b', onlyInA: [], onlyInB: [], changed: [], undecided: [] };
      continue;
    }
    if (!ta.key?.length || !tb.key?.length) {
      fail('E_NO_KEY', `table '${t}' has no primary key in schema`);
    }
    const keyIdxA = ta.key.map((k) => ta.columns.indexOf(k));
    const keyIdxB = tb.key.map((k) => tb.columns.indexOf(k));
    if (keyIdxA.includes(-1) || keyIdxB.includes(-1)) {
      fail('E_NO_KEY', `key column missing from data of table '${t}'`);
    }
    const mapA = new Map();
    const mapB = new Map();
    for (const r of ta.rows) mapA.set(keyOf(r, keyIdxA), r);
    for (const r of tb.rows) mapB.set(keyOf(r, keyIdxB), r);
    const sharedCols = ta.columns.filter((c) => tb.columns.includes(c));
    const missingColumns = {
      onlyInA: ta.columns.filter((c) => !tb.columns.includes(c)),
      onlyInB: tb.columns.filter((c) => !ta.columns.includes(c)),
    };
    const onlyInA = [];
    const onlyInB = [];
    const changed = [];
    const undecided = [];
    for (const [key, ra] of mapA) {
      const rb = mapB.get(key);
      if (!rb) { onlyInA.push(key); continue; }
      const diffs = [];
      const und = [];
      for (const col of sharedCols) {
        const ea = ra[ta.columns.indexOf(col)];
        const eb = rb[tb.columns.indexOf(col)];
        const status = compareCells(ea, eb, tol);
        if (status === 'different') diffs.push({ col, a: displayCell(ea), b: displayCell(eb) });
        else if (status === 'undecided') und.push({ col, a: displayCell(ea), b: displayCell(eb) });
      }
      if (diffs.length) changed.push({ key, cells: diffs });
      if (und.length) undecided.push({ key, cells: und });
    }
    for (const key of mapB.keys()) {
      if (!mapA.has(key)) onlyInB.push(key);
    }
    result[t] = {
      onlyInA: onlyInA.sort(),
      onlyInB: onlyInB.sort(),
      changed,
      undecided,
      missingColumns,
    };
  }
  return result;
}

export function diffSnapshots(snapA, snapB, tolOverride) {
  const tol = validateTolerance(tolOverride ?? snapB.tolerance ?? snapA.tolerance);
  return {
    a: snapA.name,
    b: snapB.name,
    tolerance: tol,
    params: diffParams(snapA.params, snapB.params),
    tables: diffTables(snapA, snapB, tol),
  };
}
