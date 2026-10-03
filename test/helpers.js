'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = Date.UTC(2026, 0, 1);

function iso(hours) {
  return new Date(BASE + hours * 3600 * 1000).toISOString();
}

// Random DAG with n in [2, 10] lots, random tests and random valid corrections.
function randomInstance(rand) {
  const n = 2 + Math.floor(rand() * 9);
  const lots = [];
  for (let i = 0; i < n; i += 1) {
    const start = Math.floor(rand() * 200);
    lots.push({
      id: `L${i}`,
      type: 'intermediate',
      production_start: iso(start),
      production_end: iso(start + 1 + Math.floor(rand() * 5)),
    });
  }
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (rand() < 0.35) {
        const edge = { from: `L${i}`, to: `L${j}` };
        if (rand() < 0.8) {
          const from = Math.floor(rand() * 220);
          edge.valid_from = iso(from);
          edge.valid_to = iso(from + Math.floor(rand() * 60));
        }
        edges.push(edge);
      }
    }
  }
  const indeg = new Map(lots.map((l) => [l.id, 0]));
  const outdeg = new Map(lots.map((l) => [l.id, 0]));
  for (const e of edges) {
    indeg.set(e.to, indeg.get(e.to) + 1);
    outdeg.set(e.from, outdeg.get(e.from) + 1);
  }
  for (const lot of lots) {
    if (indeg.get(lot.id) === 0) lot.type = 'raw_material';
    else if (outdeg.get(lot.id) === 0) lot.type = 'finished_good';
    else lot.type = 'intermediate';
  }
  const tests = [];
  let tid = 0;
  for (const lot of lots) {
    const count = Math.floor(rand() * 3);
    for (let k = 0; k < count; k += 1) {
      tests.push({ id: `T${tid}`, lot: lot.id, result: rand() < 0.4 ? 'fail' : 'pass' });
      tid += 1;
    }
  }
  return { lots, edges, tests };
}

function randomWindow(rand) {
  const from = Math.floor(rand() * 220);
  return { valid_from: iso(from), valid_to: iso(from + Math.floor(rand() * 60)) };
}

// Generates 1..4 corrections that are guaranteed to target existing objects.
function randomCorrections(rand, instance) {
  const corrections = [];
  const revoked = new Set();
  const count = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < count; k += 1) {
    const useTest = instance.tests.length > 0 && (instance.edges.length === 0 || rand() < 0.5);
    if (useTest) {
      const candidates = instance.tests.filter((t) => !revoked.has(t.id));
      if (candidates.length === 0) continue;
      const t = candidates[Math.floor(rand() * candidates.length)];
      revoked.add(t.id);
      corrections.push({ type: 'revoke_test', test_id: t.id });
    } else if (instance.edges.length > 0) {
      const e = instance.edges[Math.floor(rand() * instance.edges.length)];
      const w = randomWindow(rand);
      corrections.push({ type: 'update_edge', from: e.from, to: e.to, ...w });
    }
  }
  return corrections;
}

function applyToPlain(instance, corr) {
  if (corr.type === 'revoke_test') {
    const t = instance.tests.find((x) => x.id === corr.test_id);
    t.revoked = true;
  } else if (corr.type === 'update_edge') {
    const e = instance.edges.find((x) => x.from === corr.from && x.to === corr.to);
    e.valid_from = corr.valid_from === undefined ? null : corr.valid_from;
    e.valid_to = corr.valid_to === undefined ? null : corr.valid_to;
  }
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { mulberry32, iso, randomInstance, randomCorrections, applyToPlain, deepCopy, BASE };
