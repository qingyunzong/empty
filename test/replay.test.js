'use strict';

// Property test: for instruction sets of size n <= 9, generate legal patch
// sequences, apply them with the library, and replay them with an independent
// reference implementation (Map-based, written directly from the spec). The
// final tables and the per-account deltas must agree.

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyPatch } = require('../src/migrate');
const { verifyProof } = require('../src/verify');
const { accountDelta } = require('../src/model');

// --- independent reference implementation --------------------------------

function referenceApply(oldInstructions, ops) {
  const table = new Map();
  for (const inst of oldInstructions) table.set(inst.id, { ...inst });
  for (const op of ops) {
    if (op.op === 'split') {
      const orig = table.get(op.id);
      table.delete(op.id);
      for (const part of op.parts) {
        const out = {
          id: part.id,
          account: part.account !== undefined ? part.account : orig.account,
          currency: part.currency !== undefined ? part.currency : orig.currency,
          debit: part.debit !== undefined ? part.debit : 0,
          credit: part.credit !== undefined ? part.credit : 0,
          freeze: part.freeze !== undefined ? part.freeze : 0,
          state: part.state !== undefined ? part.state : orig.state,
        };
        const memo = part.memo !== undefined ? part.memo : orig.memo;
        if (memo !== undefined) out.memo = memo;
        table.set(out.id, out);
      }
    } else if (op.op === 'merge') {
      const ins = op.ids.map((id) => table.get(id));
      for (const id of op.ids) table.delete(id);
      const merged = {
        id: op.newId,
        account: ins[0].account,
        currency: ins[0].currency,
        debit: ins.reduce((sum, inst) => sum + inst.debit, 0),
        credit: ins.reduce((sum, inst) => sum + inst.credit, 0),
        freeze: ins.reduce((sum, inst) => sum + inst.freeze, 0),
        state: ins.every((inst) => inst.state === ins[0].state) ? ins[0].state : 'PENDING',
      };
      if (op.memo !== undefined) merged.memo = op.memo;
      table.set(merged.id, merged);
    } else if (op.op === 'restate') {
      table.set(op.id, { ...table.get(op.id), ...op.fields });
    } else {
      throw new Error(`reference: unknown op ${op.op}`);
    }
  }
  return [...table.values()];
}

// --- deterministic RNG ---------------------------------------------------

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function randomComposition(rng, total, parts) {
  const cuts = [0, total];
  for (let i = 0; i < parts - 1; i += 1) cuts.push(Math.floor(rng() * (total + 1)));
  cuts.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < parts; i += 1) out.push(cuts[i + 1] - cuts[i]);
  return out;
}

// --- generators ----------------------------------------------------------

function randomInstructions(rng, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const inst = {
      id: `i${i}`,
      account: pick(rng, ['A', 'B', 'C']),
      currency: pick(rng, ['USD', 'EUR']),
      debit: Math.floor(rng() * 1000),
      credit: Math.floor(rng() * 1000),
      freeze: Math.floor(rng() * 100),
      state: rng() < 0.3 ? 'SETTLED' : 'PENDING',
    };
    if (rng() < 0.5) inst.memo = `m${i}`;
    out.push(inst);
  }
  return out;
}

function randomLegalOps(rng, oldInstructions, count) {
  // Track the evolving table with the reference implementation so generated
  // ops are always legal (existing ids, merge compatibility, SETTLED rules).
  let table = referenceApply(oldInstructions, []);
  const ops = [];
  let counter = 0;
  const freshId = (prefix) => `${prefix}${counter++}`;
  for (let k = 0; k < count; k += 1) {
    const kind = pick(rng, ['split', 'merge', 'restate', 'restate']);
    if (kind === 'split' && table.length > 0) {
      const orig = pick(rng, table);
      const partCount = 2 + Math.floor(rng() * 2);
      const debits = randomComposition(rng, orig.debit, partCount);
      const credits = randomComposition(rng, orig.credit, partCount);
      const freezes = randomComposition(rng, orig.freeze, partCount);
      const parts = [];
      for (let p = 0; p < partCount; p += 1) {
        const part = { id: freshId('s'), debit: debits[p], credit: credits[p], freeze: freezes[p] };
        if (rng() < 0.3) part.memo = `split-${p}`;
        parts.push(part);
      }
      ops.push({ op: 'split', id: orig.id, parts });
    } else if (kind === 'merge') {
      const groups = new Map();
      for (const inst of table) {
        const key = `${inst.account} ${inst.currency}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(inst);
      }
      const candidates = [...groups.values()].filter((group) => group.length >= 2);
      if (candidates.length === 0) continue;
      const group = pick(rng, candidates);
      const shuffled = [...group].sort(() => rng() - 0.5);
      const take = 2 + Math.floor(rng() * Math.min(2, shuffled.length - 1));
      const ids = shuffled.slice(0, take).map((inst) => inst.id);
      const op = { op: 'merge', ids, newId: freshId('m') };
      if (rng() < 0.3) op.memo = 'merged';
      ops.push(op);
    } else {
      const target = pick(rng, table);
      const fields = {};
      if (target.state === 'SETTLED') {
        fields.memo = `restated-${k}`;
      } else {
        if (rng() < 0.5) fields.debit = Math.floor(rng() * 1000);
        if (rng() < 0.5) fields.credit = Math.floor(rng() * 1000);
        if (rng() < 0.3) fields.freeze = Math.floor(rng() * 100);
        if (rng() < 0.3) fields.memo = `restated-${k}`;
        if (Object.keys(fields).length === 0) fields.memo = `restated-${k}`;
      }
      ops.push({ op: 'restate', id: target.id, fields });
    }
    table = referenceApply(oldInstructions, ops);
  }
  return ops;
}

function sortedCanonical(instructions) {
  return [...instructions].map((inst) => JSON.stringify(inst)).sort();
}

// --- the property --------------------------------------------------------

test('library matches the independent reference on all generated legal patches (n <= 9)', () => {
  const TRIALS = 400;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const rng = makeRng(trial * 2654435761 + 1);
    const n = 1 + (trial % 9);
    const old = randomInstructions(rng, n);
    const opCount = 1 + Math.floor(rng() * 5);
    const ops = randomLegalOps(rng, old, opCount);
    const { instructions, proof } = applyPatch(old, ops);
    const expected = referenceApply(old, ops);
    assert.deepEqual(
      sortedCanonical(instructions),
      sortedCanonical(expected),
      `trial ${trial}: final table mismatch (n=${n}, ops=${JSON.stringify(ops)})`
    );
    assert.deepEqual(proof.perAccountDelta, accountDelta(old, expected), `trial ${trial}: perAccountDelta mismatch`);
    assert.deepEqual(verifyProof(old, instructions, proof), { ok: true }, `trial ${trial}: proof must verify`);
  }
});

test('illegal ops are rejected with the specified exit codes', () => {
  const rng = makeRng(42);
  const old = randomInstructions(rng, 5);
  old[0].state = 'SETTLED';
  assert.throws(
    () =>
      applyPatch(old, [
        { op: 'split', id: 'i1', parts: [{ id: 'z', debit: old[1].debit + 1, credit: old[1].credit, freeze: old[1].freeze }] },
      ]),
    (e) => e.exitCode === 25
  );
  assert.throws(
    () => applyPatch(old, [{ op: 'restate', id: 'i0', fields: { credit: old[0].credit + 1 } }]),
    (e) => e.exitCode === 26
  );
  const a = old.find((inst) => inst.account === 'A');
  const other = old.find((inst) => inst.account !== a.account);
  if (other) {
    assert.throws(
      () => applyPatch(old, [{ op: 'merge', ids: [a.id, other.id], newId: 'mx' }]),
      (e) => e.exitCode === 27
    );
  }
});
