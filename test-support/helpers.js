'use strict';

const { Engine } = require('../src/engine');
const { matchComponent, edgeExists } = require('../src/matcher');
const { buildCluster } = require('../src/clusters');

// Independent brute-force reference: rebuild the full dependency graph from
// scratch (adjacency matrix + BFS), match every component, build clusters.
// Used to validate the engine's incremental dirty-set maintenance.
function bruteForceClusters(rows, rule) {
  const active = rows.filter((r) => !r.revoked);
  const adj = new Map(active.map((r) => [r.key, new Set()]));
  for (const a of active) {
    for (const b of active) {
      if (a.key < b.key && edgeExists(a, b, rule)) {
        adj.get(a.key).add(b.key);
        adj.get(b.key).add(a.key);
      }
    }
  }
  const byKey = new Map(active.map((r) => [r.key, r]));
  const seen = new Set();
  const clusters = [];
  for (const r of active) {
    if (seen.has(r.key)) continue;
    const component = [];
    const stack = [r.key];
    seen.add(r.key);
    while (stack.length) {
      const k = stack.pop();
      component.push(byKey.get(k));
      for (const n of adj.get(k)) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    clusters.push(buildCluster(component, matchComponent(component, rule), rule));
  }
  clusters.sort((a, b) => (a.id < b.id ? -1 : 1));
  return clusters;
}

function bruteForce(engine) {
  return bruteForceClusters([...engine.rows.values()], engine.rule);
}

function runEvents(events, opts) {
  const engine = new Engine(opts);
  for (const event of events) engine.apply(event);
  return engine;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3600 * 1000;

function ts(hours) {
  return new Date(T0 + hours * HOUR).toISOString();
}

module.exports = { bruteForceClusters, bruteForce, runEvents, mulberry32, ts, T0, HOUR };
