import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';
import { evaluate, indexCandidates } from './vm.js';
import { readCommitted, readIndex } from './storage.js';

export function compileQuery(src) {
  return compile(check(parse(src)));
}

export function compareRecords(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.seq - b.seq;
}

function aggregate(records, aggs, groupBy) {
  const groups = new Map();
  for (const rec of records) {
    const key = groupBy ? rec[groupBy] : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const compute = (rows) => {
    const out = {};
    for (const agg of aggs) {
      if (agg.fn === 'count') { out.count = rows.length; continue; }
      const vals = rows.map((r) => r[agg.field]);
      if (agg.fn === 'sum') out[`sum_${agg.field}`] = vals.reduce((s, v) => s + v, 0);
      else if (agg.fn === 'avg') out[`avg_${agg.field}`] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      else if (agg.fn === 'min') out[`min_${agg.field}`] = vals.length ? Math.min(...vals) : null;
      else if (agg.fn === 'max') out[`max_${agg.field}`] = vals.length ? Math.max(...vals) : null;
    }
    return out;
  };
  const keys = [...groups.keys()].sort();
  if (!groupBy) return compute(groups.get('') ?? []);
  return keys.map((k) => ({ [groupBy]: k, ...compute(groups.get(k)) }));
}

// Execute a compiled query against the committed view of the database.
// Uses the per-segment time index when a ts window was extracted; the index
// covers every row of its segment, so results are identical to a full scan.
export function executeCompiled(dir, compiled) {
  const { segments, pending } = readCommitted(dir);
  const matched = [];
  for (const { seg, records } of segments) {
    let rows = null;
    if (compiled.tsRange) {
      const idx = readIndex(dir, seg.segId);
      if (idx && idx.count === records.length) {
        rows = indexCandidates(idx.entries, compiled.tsRange);
      }
    }
    if (rows === null) rows = records.map((_, i) => i);
    for (const row of rows) {
      const rec = records[row];
      if (evaluate(compiled, rec)) matched.push(rec);
    }
  }
  for (const rec of pending) {
    if (evaluate(compiled, rec)) matched.push(rec);
  }
  matched.sort(compareRecords);
  if (compiled.aggs) return { kind: 'aggregate', result: aggregate(matched, compiled.aggs, compiled.groupBy) };
  return { kind: 'records', result: matched };
}

export function executeQuery(dir, src) {
  return executeCompiled(dir, compileQuery(src));
}

// Reference implementation used by tests: plain full scan, no index.
export function referenceScan(records, src) {
  const compiled = compileQuery(src);
  const matched = records.filter((rec) => evaluate(compiled, rec));
  matched.sort(compareRecords);
  if (compiled.aggs) return { kind: 'aggregate', result: aggregate(matched, compiled.aggs, compiled.groupBy) };
  return { kind: 'records', result: matched };
}
