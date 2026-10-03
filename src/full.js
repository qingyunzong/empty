'use strict';

// Independent recursive whole-graph recomputation. This is the reference
// implementation used to cross-check the incremental Engine: it shares no
// state with it and recomputes every lot from scratch via memoized
// recursion over the raw input records.

function parseTime(value) {
  if (value === undefined || value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NaN : ms;
}

function edgeCoversWindow(edge, lot) {
  const start = parseTime(lot.production_start);
  const end = parseTime(lot.production_end);
  if (start === null && end === null) return true;
  const validFrom = parseTime(edge.valid_from);
  const validTo = parseTime(edge.valid_to);
  const lo = validFrom === null ? -Infinity : validFrom;
  const hi = validTo === null ? Infinity : validTo;
  const ps = start === null ? -Infinity : start;
  const pe = end === null ? Infinity : end;
  return lo <= ps && hi >= pe;
}

function computeAllStatuses(lots, edges, tests) {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const incoming = new Map(lots.map((l) => [l.id, []]));
  for (const e of edges) incoming.get(e.to).push(e);
  const testsByLot = new Map(lots.map((l) => [l.id, []]));
  for (const t of tests) {
    if (t.revoked) continue;
    testsByLot.get(t.lot).push(t);
  }
  const memo = new Map();
  function visit(id) {
    if (memo.has(id)) return memo.get(id);
    const lot = lotById.get(id);
    const contaminatedBy = new Set();
    let ownPass = false;
    for (const t of testsByLot.get(id)) {
      if (t.result === 'fail') contaminatedBy.add(t.id);
      else ownPass = true;
    }
    const ups = incoming.get(id).map((edge) => ({ edge, result: visit(edge.from) }));
    for (const { edge, result } of ups) {
      if (!edgeCoversWindow(edge, lot)) continue;
      for (const tid of result.contaminatedBy) contaminatedBy.add(tid);
    }
    let status;
    if (contaminatedBy.size > 0) {
      status = 'FAIL';
    } else if (ownPass) {
      status = 'PASS';
    } else if (ups.length > 0 && ups.every((u) => u.result.status === 'PASS')) {
      status = 'PASS';
    } else {
      status = 'UNKNOWN';
    }
    const out = { status, contaminatedBy: [...contaminatedBy].sort() };
    memo.set(id, out);
    return out;
  }
  const result = new Map();
  for (const lot of lots) result.set(lot.id, visit(lot.id));
  return result;
}

module.exports = { computeAllStatuses };
