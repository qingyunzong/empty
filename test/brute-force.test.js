'use strict';
// Acceptance: engine matching equals brute-force enumeration of all matchings
// (lexicographically maximal indicator vector under the total order) on small
// random samples, including cancels, corrections and rule switches.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, RULES, compareEdges } = require('../src/engine');
const { mulberry32 } = require('../helpers');

function bruteForceMatches(internals, externals, ruleVersion) {
  const rule = RULES[ruleVersion];
  const edges = [];
  for (const i of internals) {
    for (const e of externals) {
      const amountDiff = Math.abs(i.cents - e.cents);
      const dateDiff = Math.abs(i.day - e.day);
      if (amountDiff <= rule.amountToleranceCents && dateDiff <= rule.dateWindowDays) {
        edges.push({ i: i.id, e: e.id, amountDiff, dateDiff });
      }
    }
  }
  edges.sort(compareEdges);
  let best = null; // Set of edge indexes; lexicographically maximal indicator vector
  function better(candidate, incumbent) {
    if (incumbent === null) return true;
    for (let k = 0; k < edges.length; k += 1) {
      const inC = candidate.has(k);
      const inI = incumbent.has(k);
      if (inC !== inI) return inC; // prefer including the earlier (better) edge
    }
    return false;
  }
  function rec(idx, usedI, usedE, chosen) {
    if (idx === edges.length) {
      if (better(chosen, best)) best = new Set(chosen);
      return;
    }
    const edge = edges[idx];
    if (!usedI.has(edge.i) && !usedE.has(edge.e)) {
      usedI.add(edge.i);
      usedE.add(edge.e);
      chosen.add(idx);
      rec(idx + 1, usedI, usedE, chosen);
      chosen.delete(idx);
      usedI.delete(edge.i);
      usedE.delete(edge.e);
    }
    rec(idx + 1, usedI, usedE, chosen);
  }
  rec(0, new Set(), new Set(), new Set());
  const pairs = [...best].map((k) => [edges[k].i, edges[k].e].join('->')).sort();
  return pairs;
}

function engineMatches(engine) {
  return [...engine.matches.entries()].map(([i, e]) => `${i}->${e}`).sort();
}

test('engine matches brute-force optimum on random small samples', () => {
  const rand = mulberry32(20261004);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let sample = 0; sample < 60; sample += 1) {
    const engine = new Engine();
    const nI = Math.floor(rand() * 5);
    const nE = Math.floor(rand() * 5);
    const base = Date.UTC(2026, 0, 1) / 86400000;
    const mkRow = () => ({
      cents: Math.floor(rand() * 20000),
      day: base + Math.floor(rand() * 6),
    });
    const internalRows = new Map();
    const externalRows = new Map();
    for (let k = 0; k < nI; k += 1) {
      const row = mkRow();
      internalRows.set(`I${k}`, row);
      engine.apply({
        type: 'internal',
        id: `I${k}`,
        amount: row.cents / 100,
        date: new Date(row.day * 86400000).toISOString().slice(0, 10),
      });
    }
    for (let k = 0; k < nE; k += 1) {
      const row = mkRow();
      externalRows.set(`E${k}`, row);
      engine.apply({
        type: 'external',
        id: `E${k}`,
        amount: row.cents / 100,
        date: new Date(row.day * 86400000).toISOString().slice(0, 10),
      });
    }
    // Random mutations: cancel, correction, rule switch.
    if (nE > 0 && rand() < 0.5) {
      const victim = `E${Math.floor(rand() * nE)}`;
      if (externalRows.has(victim)) {
        engine.apply({ type: 'cancel', id: victim });
        externalRows.delete(victim);
      }
    }
    if (externalRows.size > 0 && rand() < 0.5) {
      const target = pick([...externalRows.keys()]);
      const row = mkRow();
      externalRows.set(target, row);
      engine.apply({
        type: 'external',
        id: target,
        amount: row.cents / 100,
        date: new Date(row.day * 86400000).toISOString().slice(0, 10),
      });
    }
    const ruleVersion = rand() < 0.5 ? 'v1' : 'v2';
    engine.apply({ type: 'rule', version: ruleVersion });

    const withIds = (map) => [...map.entries()].map(([id, r]) => ({ id, ...r }));
    const expected = bruteForceMatches(withIds(internalRows), withIds(externalRows), ruleVersion);
    assert.deepEqual(
      engineMatches(engine),
      expected,
      `sample ${sample}: engine greedy must equal brute-force optimum under rule ${ruleVersion}`
    );

    // Unmatched sets must agree too (nothing pending is silently dropped).
    const matchedI = new Set(engine.matches.keys());
    const unmatchedI = [...internalRows.keys()].filter((id) => !matchedI.has(id)).sort();
    const bruteMatchedI = new Set(expected.map((p) => p.split('->')[0]));
    assert.deepEqual(unmatchedI, [...internalRows.keys()].filter((id) => !bruteMatchedI.has(id)).sort());
  }
});
