// Acceptance 3: random event sequences (n <= 9) cross-checked state by state
// against the built-in brute-force enumerator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { enumerateCatalog, canonicalCells, recomputeDomains } from '../src/enumerator.js';
import { applyRetract } from '../src/model.js';

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

const CFG = { coordBins: 2, magBins: 2, capacity: 2 };

function randomEvents(rng, n) {
  const events = [];
  const active = [];
  let counter = 0;
  const ri = (k) => Math.floor(rng() * k);
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (active.length > 0 && r < 0.15) {
      const id = active.splice(ri(active.length), 1)[0];
      events.push({ type: 'retract_obs', id });
    } else if (active.length > 0 && r < 0.3) {
      const id = active[ri(active.length)];
      const ev = { type: 'correct_obs', id, coord: ri(CFG.coordBins), mag: ri(CFG.magBins) };
      if (rng() < 0.4) ev.ts = ri(6);
      if (rng() < 0.3) ev.conf = Math.round(rng() * 100) / 100;
      events.push(ev);
    } else {
      const id = `o${counter++}`;
      events.push({
        type: 'add_obs', id, star: `s${ri(3)}`, night: ri(2), ts: ri(6),
        coord: ri(CFG.coordBins), mag: ri(CFG.magBins), conf: Math.round(rng() * 100) / 100,
      });
      active.push(id);
    }
  }
  return events;
}

function normalizeDomains(domains) {
  const out = {};
  for (const [k, v] of Object.entries(domains)) {
    out[k] = Object.fromEntries(Object.entries(v).map(([c, ids]) => [c, [...ids].sort()]));
  }
  return out;
}

function checkCore(state, core) {
  assert.ok(core.obs.length > 0, 'core must name observations');
  assert.ok(core.events.length > 0, 'core must name events');
  assert.ok(core.constraints.length > 0, 'core must name constraints');
  // The core alone is UNSAT...
  const only = structuredClone(state);
  for (const id of Object.keys(only.obs)) {
    if (only.obs[id].active && !core.obs.includes(id)) applyRetract(only, id);
  }
  assert.equal(enumerateCatalog(only).status, 'UNSAT', 'core subset must itself be UNSAT');
  // ...and removing any single member makes it SAT (minimality).
  for (const id of core.obs) {
    const t = structuredClone(only);
    applyRetract(t, id);
    assert.equal(enumerateCatalog(t).status, 'SAT', `core not minimal: ${id} is redundant`);
  }
}

test('random sequences (n<=9): incremental state and solver match enumerator per state', () => {
  let satCount = 0;
  let unsatCount = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rng = mulberry32(seed);
    const n = 1 + Math.floor(rng() * 9);
    const events = randomEvents(rng, n);
    const engine = new Engine(CFG);
    for (let i = 0; i < events.length; i++) {
      engine.applyEvent(events[i]);
      const ctx = `seed=${seed} event=${i} ${JSON.stringify(events[i])}`;
      // Incremental domain maintenance == from-scratch recomputation.
      assert.deepEqual(normalizeDomains(engine.state.domains), normalizeDomains(recomputeDomains(engine.state)), ctx);
      // Solver verdict == enumerator verdict on the same state.
      const res = engine.applyEvent({ type: 'solve', budget: { propagation: 1_000_000, backtrack: 100_000 } });
      const enumeration = enumerateCatalog(engine.state);
      assert.equal(res.status, enumeration.status, ctx);
      if (res.status === 'SAT') {
        satCount++;
        assert.ok(
          enumeration.models.includes(canonicalCells(res.cells)),
          `${ctx}: solver model not in enumerator model set`,
        );
      } else if (res.status === 'UNSAT') {
        unsatCount++;
        checkCore(engine.state, res.unsatCore);
      } else {
        assert.fail(`${ctx}: PENDING with generous budget`);
      }
    }
  }
  assert.ok(satCount > 0 && unsatCount > 0, 'cross-check must exercise both SAT and UNSAT');
});
