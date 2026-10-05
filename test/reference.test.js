'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Genealogy } = require('../src/genealogy');
const { ReferenceModel } = require('../src/reference');

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

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function compareAll(lib, ref, step) {
  const snap = lib.snapshot();
  const refBatches = ref.batches();
  assert.equal(snap.version, ref.version, `version mismatch at step ${step}`);
  assert.deepEqual(Object.keys(snap.batches), refBatches, `batch set mismatch at step ${step}`);
  for (const b of refBatches) {
    assert.equal(snap.batches[b].status, ref.status(b), `status of ${b} at step ${step}`);
    assert.deepEqual(snap.batches[b].blockers, ref.blockers(b), `blockers of ${b} at step ${step}`);
  }
  const refEdges = [];
  for (const e of ref.events.values()) for (const i of e.inputs) refEdges.push([i, e.output]);
  const norm = (edges) => edges.map((e) => JSON.stringify(e)).sort();
  assert.deepEqual(norm(snap.edges), norm(refEdges), `edges at step ${step}`);
}

for (const seed of [1, 7, 42, 1337, 2026]) {
  test(`randomized op log matches DFS reference (seed ${seed})`, () => {
    const rand = mulberry32(seed);
    const lib = new Genealogy();
    const ref = new ReferenceModel();
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    let eventCounter = 0;

    for (let step = 0; step < 400; step++) {
      const batches = ref.batches();
      const roll = rand();

      if (roll < 0.35 && batches.length < NAMES.length) {
        const output = NAMES.find((n) => !batches.includes(n));
        const shuffled = [...batches].sort(() => rand() - 0.5);
        const inputs = shuffled.slice(0, Math.floor(rand() * 3));
        const ev = { id: `e${eventCounter++}`, output, inputs };
        lib.appendEvent(ev);
        ref.append(ev);
      } else if (roll < 0.55 && ref.events.size > 0) {
        const id = pick([...ref.events.keys()]);
        const ev = ref.events.get(id);
        const candidates = batches.filter(
          (b) => b !== ev.output && !ref.ancestorsOf(b).has(ev.output),
        );
        const shuffled = [...candidates].sort(() => rand() - 0.5);
        const inputs = shuffled.slice(0, Math.floor(rand() * 3));
        lib.correctEvent(id, { inputs });
        ref.correct(id, { inputs });
      } else if (roll < 0.65 && ref.events.size > 0) {
        const removable = [...ref.events.values()].filter(
          (e) => ![...ref.events.values()].some((o) => o.id !== e.id && o.inputs.includes(e.output)),
        );
        if (removable.length === 0) continue;
        const id = pick(removable).id;
        lib.undoEvent(id);
        ref.undo(id);
      } else if (roll < 0.8 && batches.length > 0) {
        const b = pick(batches);
        lib.hold(b);
        ref.hold(b);
      } else if (roll < 0.9 && batches.length > 0) {
        const b = pick(batches);
        lib.release(b);
        ref.release(b);
      } else if (batches.length > 0) {
        const b = pick(batches);
        lib.ship(b);
        ref.ship(b);
      } else {
        continue;
      }

      compareAll(lib, ref, step);
      if (step % 25 === 0) {
        for (const b of ref.batches()) {
          assert.deepEqual(lib.certificate(b), ref.certificate(b), `certificate of ${b} at step ${step}`);
        }
      }
    }

    for (const b of ref.batches()) {
      assert.deepEqual(lib.certificate(b), ref.certificate(b), `final certificate of ${b}`);
    }
  });
}
