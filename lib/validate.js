'use strict';

const { topoSort } = require('./engine');

function toIdMap(items, kind, errors) {
  const map = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id === '') {
      errors.push({ code: 'INVALID', message: `${kind} entry missing string id`, entry: item ?? null });
      continue;
    }
    if (map.has(item.id)) {
      errors.push({ code: 'DUPLICATE_ID', message: `duplicate ${kind} id: ${item.id}`, id: item.id });
      continue;
    }
    map.set(item.id, item);
  }
  return map;
}

// Validates raw parsed input. Returns maps on success and a list of
// errors; callers must refuse to produce certificates when errors exist.
function validate({ lots, edges, tests, corrections }) {
  const errors = [];
  const lotMap = toIdMap(lots, 'lot', errors);
  const edgeMap = toIdMap(edges, 'edge', errors);
  const testMap = toIdMap(tests, 'test', errors);

  for (const e of edgeMap.values()) {
    for (const key of ['from', 'to']) {
      if (!lotMap.has(e[key])) {
        errors.push({ code: 'UNKNOWN_LOT', message: `edge ${e.id} references unknown lot ${e[key]}`, edge: e.id, lot: e[key] ?? null });
      }
    }
  }
  for (const t of testMap.values()) {
    if (!lotMap.has(t.lot)) {
      errors.push({ code: 'UNKNOWN_LOT', message: `test ${t.id} references unknown lot ${t.lot}`, test: t.id, lot: t.lot ?? null });
    }
  }
  for (const c of corrections) {
    if (!c || typeof c !== 'object') {
      errors.push({ code: 'INVALID', message: 'correction entry is not an object', entry: c ?? null });
      continue;
    }
    if (c.type === 'revoke_test') {
      if (!testMap.has(c.test_id)) {
        errors.push({ code: 'UNKNOWN_TEST', message: `correction references unknown test ${c.test_id}`, test: c.test_id ?? null });
      }
    } else if (c.type === 'update_edge') {
      if (!edgeMap.has(c.edge_id)) {
        errors.push({ code: 'UNKNOWN_EDGE', message: `correction references unknown edge ${c.edge_id}`, edge: c.edge_id ?? null });
      }
    } else {
      errors.push({ code: 'INVALID', message: `unknown correction type: ${c.type}`, entry: c });
    }
  }

  // Cycle check only over edges whose endpoints both exist.
  const downstream = new Map();
  for (const id of lotMap.keys()) downstream.set(id, []);
  for (const e of edgeMap.values()) {
    if (lotMap.has(e.from) && lotMap.has(e.to)) downstream.get(e.from).push(e);
  }
  const order = topoSort(lotMap, downstream);
  if (order.length < lotMap.size) {
    const inCycle = [...lotMap.keys()].filter((id) => !order.includes(id)).sort();
    errors.push({ code: 'CYCLE', message: `genealogy graph has a cycle involving: ${inCycle.join(', ')}`, lots: inCycle });
  }

  return { errors, lots: lotMap, edges: edgeMap, tests: testMap };
}

module.exports = { validate };
