'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve } = require('../lib/solver');
const { reservedCents, TIERS } = require('../lib/money');

// Deterministic PRNG so the cross-check is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(rand) {
  const categories = ['travel', 'meals'];
  const nPkgs = 1 + Math.floor(rand() * 3); // 1..3 packages
  const nDocs = 1 + Math.floor(rand() * 3); // 1..3 documents
  const packages = [];
  for (let i = 0; i < nPkgs; i++) {
    const limits = {};
    for (const cat of categories) {
      if (rand() < 0.8) limits[cat] = Math.floor(rand() * 301);
    }
    if (Object.keys(limits).length === 0) limits.travel = Math.floor(rand() * 301);
    packages.push({ id: `P${i}`, limits });
  }
  const docs = [];
  for (let i = 0; i < nDocs; i++) {
    const tiers = TIERS.filter(() => rand() < 0.7);
    docs.push({
      id: `R${i}`,
      category: categories[Math.floor(rand() * categories.length)],
      cents: Math.floor(rand() * 401),
      tiers: tiers.length > 0 ? tiers : ['full'],
      group: rand() < 0.4 ? 'G' : undefined,
    });
  }
  return { packages, docs };
}

// Brute-force: enumerate every (package per group) x (tier per doc) combo.
function bruteForceFeasible(packages, docs) {
  const groupKeys = [...new Set(docs.map((d) => d.group ?? d.id))];
  const combos = [];
  const pkgChoice = new Array(groupKeys.length).fill(0);
  const tierChoice = new Array(docs.length).fill(0);

  function feasible() {
    const used = packages.map(() => Object.create(null));
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const g = groupKeys.indexOf(d.group ?? d.id);
      const p = pkgChoice[g];
      const amt = reservedCents(d.cents, d.tiers[tierChoice[i]]);
      const cat = d.category;
      used[p][cat] = (used[p][cat] ?? 0) + amt;
      if (used[p][cat] > (packages[p].limits[cat] ?? 0)) return false;
    }
    return true;
  }

  function walkTier(i) {
    if (i === docs.length) {
      if (feasible()) combos.push(true);
      return combos.length > 0;
    }
    for (let t = 0; t < docs[i].tiers.length; t++) {
      tierChoice[i] = t;
      if (walkTier(i + 1)) return true;
    }
    return false;
  }

  function walkPkg(g) {
    if (g === groupKeys.length) return walkTier(0);
    for (let p = 0; p < packages.length; p++) {
      pkgChoice[g] = p;
      if (walkPkg(g + 1)) return true;
    }
    return false;
  }

  return walkPkg(0);
}

function assertAssignmentValid(packages, docs, result) {
  const used = packages.map(() => Object.create(null));
  const groupPkg = new Map();
  assert.equal(result.assignments.length, docs.length);
  for (const a of result.assignments) {
    const d = docs.find((x) => x.id === a.id);
    assert.ok(d, `assignment for unknown doc ${a.id}`);
    assert.ok(d.tiers.includes(a.tier), `tier ${a.tier} not allowed for ${a.id}`);
    assert.equal(a.reservedCents, reservedCents(d.cents, a.tier));
    const pkgIdx = packages.findIndex((p) => p.id === a.packageId);
    assert.ok(pkgIdx >= 0, `unknown package ${a.packageId}`);
    const gKey = d.group ?? d.id;
    if (groupPkg.has(gKey)) {
      assert.equal(groupPkg.get(gKey), a.packageId, `group ${gKey} split across packages`);
    } else {
      groupPkg.set(gKey, a.packageId);
    }
    used[pkgIdx][d.category] = (used[pkgIdx][d.category] ?? 0) + a.reservedCents;
  }
  for (let p = 0; p < packages.length; p++) {
    for (const [cat, amt] of Object.entries(used[p])) {
      assert.ok(amt <= (packages[p].limits[cat] ?? 0), `package ${p.id} category ${cat} over limit`);
    }
  }
}

test('solver matches brute-force enumeration (<=3 packages, <=3 documents)', () => {
  const rand = mulberry32(20261003);
  const CASES = 300;
  for (let i = 0; i < CASES; i++) {
    const { packages, docs } = randomCase(rand);
    const result = solve({ packages, docs, budget: 1000000 });
    const feasible = bruteForceFeasible(packages, docs);
    assert.equal(
      result.status,
      feasible ? 'OK' : 'UNSAT',
      `case ${i} mismatch: ${JSON.stringify({ packages, docs, status: result.status })}`
    );
    if (result.status === 'OK') {
      assertAssignmentValid(packages, docs, result);
    } else {
      assert.ok(result.conflicts.length > 0, `case ${i}: UNSAT without conflict explanation`);
    }
  }
});

test('grouped documents share one package in the cross-check as well', () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 100; i++) {
    const { packages, docs } = randomCase(rand);
    for (const d of docs) d.group = 'ALL';
    const result = solve({ packages, docs, budget: 1000000 });
    if (result.status === 'OK') {
      const pkgs = new Set(result.assignments.map((a) => a.packageId));
      assert.equal(pkgs.size, 1);
    }
  }
});
