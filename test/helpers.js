'use strict';

// Independent oracle: a plain recursive full recomputation, written
// separately from lib/engine.js, used to cross-check incremental results.

function oracleStatuses(input) {
  const lots = new Map(input.lots.map((l) => [l.id, l]));
  const edges = input.edges.map((e) => ({ ...e }));
  const tests = input.tests.map((t) => ({ ...t }));
  const revoked = new Set();
  for (const c of input.corrections || []) {
    if (c.type === 'revoke_test') {
      revoked.add(c.test_id);
    } else if (c.type === 'update_edge') {
      const e = edges.find((x) => x.id === c.edge_id);
      if (c.valid_from !== undefined) e.valid_from = c.valid_from;
      if (c.valid_to !== undefined) e.valid_to = c.valid_to;
    }
  }
  const upstream = new Map();
  for (const id of lots.keys()) upstream.set(id, []);
  for (const e of edges) upstream.get(e.to).push(e);

  function covers(edge, lot) {
    const w = lot.window || {};
    if (w.start && edge.valid_from && edge.valid_from > w.start) return false;
    if (w.end && edge.valid_to && edge.valid_to < w.end) return false;
    return true;
  }

  const memo = new Map();
  function status(id) {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, 'UNKNOWN'); // guard; input is a DAG
    const lot = lots.get(id);
    const active = tests.filter((t) => t.lot === id && !revoked.has(t.id));
    let own;
    if (active.some((t) => t.result === 'fail')) own = 'FAIL';
    else if (active.length === 0) own = 'UNKNOWN';
    else own = 'PASS';
    const parts = [own];
    for (const e of upstream.get(id)) {
      if (covers(e, lot)) parts.push(status(e.from));
    }
    let result;
    if (parts.includes('FAIL')) result = 'FAIL';
    else if (parts.includes('UNKNOWN')) result = 'UNKNOWN';
    else result = 'PASS';
    memo.set(id, result);
    return result;
  }

  const out = new Map();
  for (const id of lots.keys()) out.set(id, status(id));
  return out;
}

// Applies corrections to raw input data, returning corrected copies —
// used to build a "full recompute from scratch" engine for comparison.
function applyCorrectionsToData(input) {
  const edges = input.edges.map((e) => ({ ...e }));
  const revoked = new Set();
  for (const c of input.corrections || []) {
    if (c.type === 'revoke_test') {
      revoked.add(c.test_id);
    } else if (c.type === 'update_edge') {
      const e = edges.find((x) => x.id === c.edge_id);
      if (c.valid_from !== undefined) e.valid_from = c.valid_from;
      if (c.valid_to !== undefined) e.valid_to = c.valid_to;
    }
  }
  return {
    lots: input.lots.map((l) => ({ ...l })),
    edges,
    tests: input.tests.filter((t) => !revoked.has(t.id)).map((t) => ({ ...t })),
  };
}

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function day(i, hour = 0) {
  return `2026-01-${String(10 + i).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
}

// Random DAG with n lots, random edges/windows/tests/corrections.
function randomCase(seed, n) {
  const rand = makeRng(seed);
  const lots = [];
  for (let i = 0; i < n; i++) {
    lots.push({ id: `L${i}`, window: { start: day(i), end: day(i, 12) } });
  }
  const edges = [];
  let ec = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < 0.35) {
        const e = { id: `E${ec++}`, from: `L${i}`, to: `L${j}` };
        if (rand() < 0.6) {
          e.valid_from = '2026-01-01T00:00:00Z';
          e.valid_to = '2026-02-28T00:00:00Z';
        } else {
          // Ends mid-window of the consumer: does not cover.
          e.valid_from = '2026-01-01T00:00:00Z';
          e.valid_to = day(j, 6);
        }
        edges.push(e);
      }
    }
  }
  const tests = [];
  let tc = 0;
  for (const l of lots) {
    const k = Math.floor(rand() * 3);
    for (let m = 0; m < k; m++) {
      tests.push({ id: `T${tc++}`, lot: l.id, result: rand() < 0.25 ? 'fail' : 'pass' });
    }
  }
  const corrections = [];
  const nc = Math.floor(rand() * 4);
  for (let c = 0; c < nc; c++) {
    if (tests.length > 0 && rand() < 0.5) {
      corrections.push({ type: 'revoke_test', test_id: tests[Math.floor(rand() * tests.length)].id });
    } else if (edges.length > 0) {
      const e = edges[Math.floor(rand() * edges.length)];
      corrections.push({
        type: 'update_edge',
        edge_id: e.id,
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: rand() < 0.5 ? '2026-03-31T00:00:00Z' : '2026-01-15T00:00:00Z',
      });
    }
  }
  return { lots, edges, tests, corrections };
}

module.exports = { oracleStatuses, applyCorrectionsToData, randomCase, makeRng };
