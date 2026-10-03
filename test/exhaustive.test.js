'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../lib/engine');
const { ev, mulberry32, referenceLedger, permutations } = require('./helpers');

// Builds a legal event set: per-acct branchSeq is dense from 1, corrections
// reference an earlier not-yet-corrected event on the same account.
function makeEvents(n, rng) {
  const accts = ['A', 'B', 'C'];
  const events = [];
  const seq = { A: 0, B: 0, C: 0 };
  const correctable = { A: [], B: [], C: [] };
  for (let i = 0; i < n; i++) {
    const acct = accts[Math.floor(rng() * (n < 3 ? 2 : 3))];
    seq[acct]++;
    const id = `e${i}`;
    const doCorrect = correctable[acct].length > 0 && rng() < 0.3;
    if (doCorrect) {
      const idx = Math.floor(rng() * correctable[acct].length);
      const target = correctable[acct].splice(idx, 1)[0];
      events.push(ev(id, acct, Math.floor(rng() * 200) - 100, seq[acct], Math.floor(rng() * 20), { replaces: target }));
    } else {
      events.push(ev(id, acct, Math.floor(rng() * 200) - 100, seq[acct], Math.floor(rng() * 20)));
      correctable[acct].push(id);
    }
  }
  return events;
}

function runEngine(events) {
  const engine = new Engine({ window: 16 });
  for (const e of events) engine.accept(e);
  engine.finalize();
  return engine.balancesObj();
}

// Acceptance 5: exhaustive legal topologies (arrival permutations) for
// n <= 7, seeded random permutations for n = 8..10, checked against an
// independent reference ledger.
test('acceptance 5: exhaustive permutations for n <= 7 match reference ledger', () => {
  const rng = mulberry32(12345);
  for (let n = 1; n <= 7; n++) {
    const events = makeEvents(n, rng);
    const expected = referenceLedger(events);
    let count = 0;
    for (const perm of permutations(events)) {
      assert.deepEqual(runEngine(perm), expected, `n=${n} perm=${perm.map((e) => e.eventId)}`);
      count++;
    }
    assert.equal(count, factorial(n));
  }
});

test('acceptance 5: sampled permutations for n = 8..10 match reference ledger', () => {
  const rng = mulberry32(999);
  for (const n of [8, 9, 10]) {
    const events = makeEvents(n, rng);
    const expected = referenceLedger(events);
    for (let s = 0; s < 200; s++) {
      const perm = events.slice();
      for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      assert.deepEqual(runEngine(perm), expected, `n=${n} sample=${s}`);
    }
  }
});

test('acceptance 5: random close placement never changes final balances', () => {
  const rng = mulberry32(777);
  for (let trial = 0; trial < 100; trial++) {
    const events = makeEvents(6, rng);
    const expected = referenceLedger(events);
    const engine = new Engine({ window: 16 });
    const cutoff = Math.floor(rng() * 25);
    const closeAt = Math.floor(rng() * (events.length + 1));
    events.forEach((e, i) => {
      if (i === closeAt) engine.accept({ type: 'close', periodId: 'PX', cutoff });
      engine.accept(e);
    });
    if (closeAt === events.length) engine.accept({ type: 'close', periodId: 'PX', cutoff });
    engine.finalize();
    assert.deepEqual(engine.balancesObj(), expected, `trial=${trial}`);
  }
});

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}
