import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan } from '../src/daybook.js';

// Exhaustive oracle check: for days of n<=6 entries, enumerate every drop
// subset and every single move, and verify applyPlan accepts exactly the
// plans that preserve per-account nets and REVERSAL causality.

function makeEntries(n) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ id: `e${i}`, account: `a${i % 2}`, amount: i + 1, type: 'NORMAL' });
  }
  if (n >= 2) {
    // last entry reverses e0 on the same account
    entries[n - 1] = {
      id: `e${n - 1}`,
      account: 'a0',
      amount: -1,
      type: 'REVERSAL',
      reversalOf: 'e0',
    };
  }
  return entries;
}

function* subsets(ids) {
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    yield ids.filter((_, i) => mask & (1 << i));
  }
}

function netsOf(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.account, (m.get(e.account) ?? 0) + e.amount);
  return m;
}

function oracle(entries, dropIds, move) {
  const drop = new Set(dropIds);
  const remaining = entries.filter((e) => !drop.has(e.id));
  // net: dropped amounts must net to zero per account
  const droppedNet = netsOf(entries.filter((e) => drop.has(e.id)));
  for (const v of droppedNet.values()) if (Math.abs(v) > 1e-9) return null;
  // causality: kept reversal needs its original
  const rev = entries.find((e) => e.type === 'REVERSAL');
  if (rev && !drop.has(rev.id) && drop.has(rev.reversalOf)) return null;
  // move endpoints must survive
  if (move && (drop.has(move[0]) || drop.has(move[1]))) return null;
  const out = remaining.slice();
  if (move) {
    const i = out.findIndex((e) => e.id === move[0]);
    const [item] = out.splice(i, 1);
    out.splice(out.findIndex((e) => e.id === move[1]), 0, item);
  }
  // causality: reversal must not precede original
  if (rev && out.some((e) => e.id === rev.id)) {
    const pi = out.findIndex((e) => e.id === rev.reversalOf);
    const pr = out.findIndex((e) => e.id === rev.id);
    if (pi > pr) return null;
  }
  return out;
}

test('enumerate drop/move subsets for n<=6 against net+causality oracle', () => {
  let checked = 0;
  let accepted = 0;
  for (let n = 1; n <= 6; n++) {
    const entries = makeEntries(n);
    const ids = entries.map((e) => e.id);
    const moves = [null];
    for (const a of ids) for (const b of ids) if (a !== b) moves.push([a, b]);

    for (const dropIds of [...subsets(ids)]) {
      for (const move of moves) {
        const plan = { dropIds };
        if (move) plan.moveBefore = [move];
        const expected = oracle(entries, dropIds, move);
        checked++;
        if (expected === null) {
          assert.throws(
            () => applyPlan(entries, plan),
            (e) => e.code === 'PLAN_INVALID' && e.exitCode === 22,
            `n=${n} drop=${dropIds} move=${move} should be rejected`,
          );
        } else {
          accepted++;
          const out = applyPlan(entries, plan);
          assert.deepEqual(
            out.map((e) => e.id),
            expected.map((e) => e.id),
            `n=${n} drop=${dropIds} move=${move} order mismatch`,
          );
          // accepted plans preserve per-account nets
          const before = netsOf(entries);
          const after = netsOf(out);
          for (const [acc, v] of before) {
            assert.ok(Math.abs((after.get(acc) ?? 0) - v) <= 1e-9, `net drift on ${acc}`);
          }
          // accepted plans keep reversals after their originals
          const pos = new Map(out.map((e, i) => [e.id, i]));
          for (const e of out) {
            if (e.type === 'REVERSAL') assert.ok(pos.get(e.reversalOf) < pos.get(e.id));
          }
        }
      }
    }
  }
  assert.ok(checked >= 2934, `expected >=2934 enumerated plans, got ${checked}`);
  assert.ok(accepted > 0);
  console.log(`enumerated ${checked} plans (n<=6), accepted ${accepted}, rejected ${checked - accepted}`);
});
