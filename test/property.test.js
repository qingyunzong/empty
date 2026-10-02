import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, shuffle } from '../testlib/helpers.js';
import { createRecord, vcMerge } from '../lib/record.js';
import { loadRecords, causalOrder, verify } from '../lib/verify.js';
import { sha256hex } from '../lib/hash.js';
import { canonical } from '../lib/canon.js';

// Independent reference: enumerate every linear extension of the causality
// poset and take the lexicographically smallest by hash sequence. The
// library's greedy min-hash Kahn sort must produce exactly that order.
function referenceOrder(records) {
  const byHash = new Map(records.map((r) => [r.hash, r]));
  const bySiteSeq = new Map(records.map((r) => [`${r.site}:${r.seq}`, r]));
  const deps = new Map();
  for (const r of records) {
    const d = new Set();
    if (r.prev !== null && byHash.has(r.prev)) d.add(r.prev);
    if (r.type === 'revoke' && byHash.has(r.target)) d.add(r.target);
    for (const [site, n] of Object.entries(r.vc)) {
      const dep = bySiteSeq.get(`${site}:${n}`);
      if (dep) d.add(dep.hash);
    }
    d.delete(r.hash);
    deps.set(r.hash, d);
  }
  let best = null;
  const chosen = [];
  const used = new Set();
  function better(candidate, incumbent) {
    if (incumbent === null) return true;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] !== incumbent[i]) return candidate[i] < incumbent[i];
    }
    return false;
  }
  function walk() {
    if (chosen.length === records.length) {
      if (better(chosen, best)) best = [...chosen];
      return;
    }
    // Prune: current prefix must not already be worse than best.
    if (best !== null && !better(chosen, best.slice(0, chosen.length))) return;
    for (const r of records) {
      if (used.has(r.hash)) continue;
      let ready = true;
      for (const dep of deps.get(r.hash)) {
        if (!used.has(dep)) { ready = false; break; }
      }
      if (!ready) continue;
      used.add(r.hash);
      chosen.push(r.hash);
      walk();
      chosen.pop();
      used.delete(r.hash);
    }
  }
  walk();
  return best;
}

function simulate(rand, nSites, totalSteps) {
  const sites = ['A', 'B', 'C'].slice(0, nSites);
  const knowledge = new Map(sites.map((s) => [s, {}]));
  const prev = new Map(sites.map((s) => [s, null]));
  const epoch = new Map(sites.map((s) => [s, 1]));
  const records = [];
  for (let i = 0; i < totalSteps; i++) {
    const site = sites[Math.floor(rand() * sites.length)];
    // Randomly sync knowledge from another site (offline log exchange).
    if (rand() < 0.5 && sites.length > 1) {
      const others = sites.filter((s) => s !== site);
      const from = others[Math.floor(rand() * others.length)];
      vcMerge(knowledge.get(site), knowledge.get(from));
    }
    if (rand() < 0.2) epoch.set(site, epoch.get(site) + 1);
    const rec = createRecord({
      site,
      epoch: epoch.get(site),
      type: 'step',
      payload: { i },
      prev: prev.get(site),
      knowledge: knowledge.get(site),
    });
    knowledge.set(site, vcMerge(vcMerge({}, knowledge.get(site)), rec.vc));
    prev.set(site, rec.hash);
    records.push(rec);
  }
  return records;
}

// Acceptance 4: random <=9 steps, checked against independent enumeration.
test('random <=9-step runs match independent linear-extension enumeration', () => {
  const rand = mulberry32(20261002);
  for (let trial = 0; trial < 40; trial++) {
    const nSites = 2 + Math.floor(rand() * 2);
    const totalSteps = 1 + Math.floor(rand() * 9); // 1..9 steps
    const records = simulate(rand, nSites, totalSteps);
    const input = shuffle(records, rand);

    const ours = causalOrder(loadRecords(input)).map((r) => r.hash);
    const expected = referenceOrder(records);
    assert.deepEqual(ours, expected, `trial ${trial}: order must match independent enumeration`);

    const cert = verify(input);
    assert.equal(cert.status, 'ok');
    assert.deepEqual(cert.missing, []);
    const head = sha256hex(canonical(ours));
    assert.equal(cert.head, head, 'head commits to the canonical order');
  }
});
