import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../src/catalog.js';
import { isUnsatObservations } from '../src/solver.js';
import { enumerate, validateModel } from '../src/enumerator.js';

// Acceptance 1: a correction triggers a chained reassignment and the output
// explains the conflict.
test('acceptance 1: correct_obs cascades reassignments and explains conflicts', () => {
  const cat = new Catalog({ coords: 3, mags: 2, creds: 2, capacity: 10 });
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 0, mag: 0, cred: 0 });
  cat.applyEvent({ type: 'add_obs', id: 'o2', star: 'B', night: 0, coord: 2, mag: 1, cred: 1 });
  cat.applyEvent({ type: 'add_obs', id: 'o3', star: 'C', night: 1, coord: [1, 2], mag: 0, cred: 0 });

  // Baseline cascade: B owns bin 2, so C's domain collapses to {1}.
  const solved = cat.applyEvent({ type: 'solve' });
  assert.equal(solved.status, 'SAT');
  assert.deepEqual(solved.model, {
    A: { coord: 0, mag: 0, cred: 0 },
    B: { coord: 2, mag: 1, cred: 1 },
    C: { coord: 1, mag: 0, cred: 0 },
  });

  // The correction widens C's candidates to {0, 1}; the alldiff cascade then
  // reassigns C away from bin 0 because A owns it.
  const corrected = cat.applyEvent({ type: 'correct_obs', id: 'o3', coord: [0, 1] });
  assert.deepEqual(corrected.effects.cascade, [
    { star: 'C', field: 'coord', removed: 0, because: { star: 'A', coord: 0 } },
  ], 'chained reassignment is reported incrementally');
  assert.deepEqual(corrected.effects.conflicts, []);

  // A conflicting correction pins C to bin 2, which B already owns; the
  // conflict explanation names the constraint and both stars.
  const clash = cat.applyEvent({ type: 'correct_obs', id: 'o3', coord: 2 });
  assert.equal(clash.effects.conflicts.length, 1);
  assert.equal(clash.effects.conflicts[0].constraint, 'exclusive_attribution');
  assert.match(clash.effects.conflicts[0].message, /'B' and 'C'/);

  const unsat = cat.applyEvent({ type: 'solve' });
  assert.equal(unsat.status, 'UNSAT');
  assert.deepEqual(unsat.core.constraints, ['exclusive_attribution']);
  assert.deepEqual(unsat.core.obs, ['o2', 'o3']);
  // The core names the add events plus every correction that touched them.
  assert.deepEqual(unsat.core.events, [1, 2, 3, 4]);
});

// Acceptance 2: undo to a middle checkpoint, keep going, and the solve result
// is identical to replaying the surviving events from scratch.
test('acceptance 2: solve after undo_to equals replay from scratch', () => {
  const limits = { coords: 4, mags: 2, creds: 2, capacity: 4 };
  const cat = new Catalog(limits);
  const run = (ev) => cat.applyEvent(ev);

  run({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 0, mag: 0, cred: 0 });
  run({ type: 'add_obs', id: 'o2', star: 'B', night: 0, coord: [1, 2], mag: 1, cred: 1 });
  run({ type: 'checkpoint', name: 'cp1' });
  run({ type: 'add_obs', id: 'o3', star: 'C', night: 1, coord: 3, mag: 0, cred: 0 });
  run({ type: 'checkpoint', name: 'cp2' });
  run({ type: 'add_obs', id: 'o4', star: 'D', night: 1, coord: 0, mag: 1, cred: 1 }); // clashes with A
  const unsat = run({ type: 'solve' });
  assert.equal(unsat.status, 'UNSAT');

  // Undo to the middle checkpoint, then continue on a different path.
  run({ type: 'undo_to', name: 'cp2' });
  run({ type: 'add_obs', id: 'o5', star: 'D', night: 1, coord: [1, 2], mag: 1, cred: 1 });
  run({ type: 'correct_obs', id: 'o2', coord: 2 });
  const continued = run({ type: 'solve', prop_budget: 500, back_budget: 500 });
  assert.equal(continued.status, 'SAT');

  // Replay the effective log from scratch and compare solve results.
  const replayed = Catalog.replay(cat.eventLog, limits);
  const fresh = replayed.solve({ propagation: 500, backtracking: 500 });
  delete fresh.coreObs;
  delete continued.type;
  assert.deepEqual(fresh, continued, 'continuing after undo matches a fresh replay');
});

// Acceptance 3: for random event streams of n <= 9 events, the solver agrees
// with the built-in brute-force enumerator on every state.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 3: random n<=9 event streams match the enumerator state by state', () => {
  const limits = { coords: 3, mags: 2, creds: 2, capacity: 2 };
  const pick = (rng, n) => Math.floor(rng() * n);
  const bin = (rng, n) => {
    if (rng() < 0.6) return pick(rng, n);
    const set = new Set();
    const count = 1 + pick(rng, n);
    while (set.size < count) set.add(pick(rng, n));
    return [...set].sort((a, b) => a - b);
  };

  const TRIALS = 400;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const rng = mulberry32(trial * 7919 + 13);
    const cat = new Catalog(limits);
    const n = 1 + pick(rng, 9); // 1..9 events
    for (let i = 0; i < n; i += 1) {
      const roll = rng();
      const ids = [...cat.obsById.keys()];
      if (roll < 0.5 || ids.length === 0) {
        cat.applyEvent({
          type: 'add_obs',
          id: `o${pick(rng, 4)}`,
          star: `s${pick(rng, 3)}`,
          night: pick(rng, 3),
          coord: bin(rng, 3),
          mag: bin(rng, 2),
          cred: bin(rng, 2),
        });
      } else if (roll < 0.65) {
        cat.applyEvent({ type: 'retract_obs', id: ids[pick(rng, ids.length)] });
      } else if (roll < 0.8) {
        const fields = {};
        if (rng() < 0.5) fields.coord = bin(rng, 3);
        if (rng() < 0.3) fields.mag = bin(rng, 2);
        if (rng() < 0.3) fields.star = `s${pick(rng, 3)}`;
        if (rng() < 0.3) fields.night = pick(rng, 3);
        if (Object.keys(fields).length === 0) fields.cred = bin(rng, 2);
        cat.applyEvent({ type: 'correct_obs', id: ids[pick(rng, ids.length)], ...fields });
      } else if (roll < 0.9) {
        cat.applyEvent({ type: 'checkpoint', name: `cp${pick(rng, 3)}` });
      } else if (cat.checkpoints.length > 0) {
        const top = cat.checkpoints[cat.checkpoints.length - 1].name;
        cat.applyEvent({ type: 'undo_to', name: top });
      }
    }

    const obs = cat.activeObs();
    const result = cat.solve({ propagation: 100000, backtracking: 100000 });
    assert.notEqual(result.status, 'PENDING', `trial ${trial}: generous budgets must decide`);
    const brute = enumerate(obs, limits);
    assert.equal(result.status, brute.status,
      `trial ${trial}: solver=${result.status} enumerator=${brute.status} log=${JSON.stringify(cat.eventLog)}`);

    if (result.status === 'SAT') {
      assert.ok(validateModel(obs, limits, result.model), `trial ${trial}: model must be valid`);
    } else {
      assert.ok(result.core.events.length > 0, `trial ${trial}: UNSAT core names events`);
      assert.ok(result.core.constraints.length > 0, `trial ${trial}: UNSAT core names constraints`);
      for (const index of result.core.events) {
        assert.ok(index >= 0 && index < cat.eventLog.length, `trial ${trial}: core index in range`);
        assert.ok(['add_obs', 'correct_obs'].includes(cat.eventLog[index].type),
          `trial ${trial}: core events are observation events`);
      }
      assert.ok(isUnsatObservations(result.coreObs, limits), `trial ${trial}: core is UNSAT`);
      for (const o of result.coreObs) {
        assert.ok(!isUnsatObservations(result.coreObs.filter((x) => x !== o), limits),
          `trial ${trial}: core is minimal w.r.t. ${o.id}`);
      }
    }
  }
});

// Acceptance 4: at the budget boundary the answer is PENDING, never UNSAT.
test('acceptance 4: budget exhaustion returns PENDING (exit path), not UNSAT', () => {
  const limits = { coords: 3, mags: 2, creds: 2, capacity: 4 };
  const cat = new Catalog(limits);
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: [0, 1], mag: 0, cred: 0 });
  cat.applyEvent({ type: 'add_obs', id: 'o2', star: 'B', night: 0, coord: [0, 1], mag: 1, cred: 1 });

  const pending = cat.applyEvent({ type: 'solve', prop_budget: 100, back_budget: 0 });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.reason, 'BUDGET_EXCEEDED');
  assert.ok(pending.facts, 'PENDING keeps the propagated facts');

  // The very same instance is decidable with a (tiny) budget: PENDING was a
  // budget artifact, not an UNSAT in disguise.
  const decided = cat.applyEvent({ type: 'solve', prop_budget: 100, back_budget: 4 });
  assert.equal(decided.status, 'SAT');

  // And a genuinely UNSAT instance stays UNSAT under any sufficient budget.
  cat.applyEvent({ type: 'correct_obs', id: 'o1', coord: 0 });
  cat.applyEvent({ type: 'correct_obs', id: 'o2', coord: 0 });
  const unsat = cat.applyEvent({ type: 'solve', prop_budget: 100, back_budget: 100 });
  assert.equal(unsat.status, 'UNSAT');
  assert.deepEqual(unsat.core.constraints, ['exclusive_attribution']);
});
