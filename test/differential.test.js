'use strict';

// Acceptance 1: two plates, at most 8 wells each. After every op the
// incremental engine is compared against a from-scratch full enumeration:
// node values, invalid sets, and certificates (changed sets + hash).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, hashOutputs, sameOut } = require('../src/engine');
const { fullRecompute } = require('../src/reference');
const { dispatch } = require('../src/dispatch');

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function norm(outputs) {
  const o = {};
  for (const id of [...outputs.keys()].sort()) {
    const n = outputs.get(id);
    o[id] = [n.value, n.error, n.invalid];
  }
  return o;
}

function invalidSet(outputs) {
  return [...outputs.keys()].filter((id) => outputs.get(id).invalid).sort();
}

function changedIds(a, b) {
  const ids = new Set([...a.keys(), ...b.keys()]);
  const out = [];
  for (const id of ids) {
    if (!sameOut(a.get(id) ?? null, b.get(id) ?? null)) out.push(id);
  }
  return out.sort();
}

function makeScript(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const ops = [{ op: 'addPlate', plate: 'P1' }, { op: 'addPlate', plate: 'P2' }];
  const wells = { P1: [], P2: [] };
  const groups = [];
  const absorbance = () => {
    const r = rnd();
    if (r < 0.1) return 0; // exercise zero denominators
    return Math.round(rnd() * 3000) / 1000;
  };
  for (const plate of ['P1', 'P2']) {
    const n = 1 + Math.floor(rnd() * 8); // <= 8 wells per plate
    for (let i = 1; i <= n; i++) {
      ops.push({ op: 'addWell', plate, well: `W${i}`, absorbance: absorbance() });
      wells[plate].push(`W${i}`);
    }
    ops.push({ op: 'setControl', plate, kind: 'neg', well: pick(wells[plate]) });
    ops.push({ op: 'setControl', plate, kind: 'pos', well: pick(wells[plate]) });
  }
  const allRefs = () => [
    ...wells.P1.map((w) => `P1/${w}`),
    ...wells.P2.map((w) => `P2/${w}`),
  ];
  for (const g of ['G1', 'G2', 'G3']) {
    const refs = allRefs().filter(() => rnd() < 0.4);
    ops.push({ op: 'addReplicate', group: g, wells: refs });
    groups.push(g);
  }

  let undoDepth = 0;
  for (let step = 0; step < 150; step++) {
    const r = rnd();
    if (r < 0.22) {
      const plate = pick(['P1', 'P2']);
      if (wells[plate].length) {
        ops.push({ op: 'setAbsorbance', plate, well: pick(wells[plate]), absorbance: absorbance() });
      }
    } else if (r < 0.32) {
      const plate = pick(['P1', 'P2']);
      const roll = rnd();
      const well = roll < 0.1 ? null : roll < 0.2 ? 'MISSING' : pick(wells[plate]);
      ops.push({ op: 'setControl', plate, kind: pick(['neg', 'pos']), well });
    } else if (r < 0.48) {
      const nonEmpty = groups.filter((g) => true);
      const from = pick(nonEmpty);
      let to = pick(groups);
      if (to !== from) {
        ops.push({ op: 'moveWell', from, to, well: pick(allRefs()) });
      }
    } else if (r < 0.56) {
      const plate = pick(['P1', 'P2']);
      if (wells[plate].length < 8) {
        const well = `X${step}`;
        wells[plate].push(well);
        ops.push({ op: 'addWell', plate, well, absorbance: absorbance() });
      }
    } else if (r < 0.64) {
      const plate = pick(['P1', 'P2']);
      if (wells[plate].length > 0) {
        const well = pick(wells[plate]);
        wells[plate] = wells[plate].filter((w) => w !== well);
        ops.push({ op: 'removeWell', plate, well });
      }
    } else if (r < 0.7) {
      const g = `G${groups.length + 1}`;
      groups.push(g);
      ops.push({ op: 'addReplicate', group: g, wells: allRefs().filter(() => rnd() < 0.5) });
    } else if (r < 0.76 && groups.length > 1) {
      const g = groups.pop();
      ops.push({ op: 'removeReplicate', group: g });
    } else if (r < 0.88 && undoDepth > 0) {
      ops.push({ op: 'undo' });
      undoDepth--;
    } else if (r < 0.94) {
      ops.push({ op: 'redo' });
    } else {
      const plate = pick(['P1', 'P2']);
      if (wells[plate].length) {
        ops.push({ op: 'setAbsorbance', plate, well: pick(wells[plate]), absorbance: absorbance() });
      }
    }
    if (!['undo', 'redo'].includes(ops[ops.length - 1].op)) undoDepth++;
  }
  return ops;
}

for (const seed of [11, 222, 3333]) {
  test(`acceptance 1: incremental matches full enumeration (seed ${seed})`, () => {
    const eng = new Engine();
    const ops = makeScript(seed);
    let prevRef = new Map();
    for (let i = 0; i < ops.length; i++) {
      const res = dispatch(eng, ops[i]);
      const ref = fullRecompute(eng.state);
      const ctx = `op #${i}: ${JSON.stringify(ops[i])}`;
      if (res.error) {
        // failed ops must leave the state untouched
        assert.equal(res.error, 'E_OP', ctx);
        assert.deepEqual(norm(eng.outputs), norm(prevRef), ctx);
        prevRef = ref;
        continue;
      }
      // values
      assert.deepEqual(norm(eng.outputs), norm(ref), ctx);
      // invalid sets
      assert.deepEqual(invalidSet(eng.outputs), invalidSet(ref), ctx);
      // certificate: changed set matches the reference diff, hash matches
      assert.deepEqual(res.certificate.changed, changedIds(prevRef, ref), ctx);
      assert.equal(res.certificate.hash, hashOutputs(ref), ctx);
      // invalidated set covers everything that changed (minimality superset)
      for (const id of res.certificate.changed) {
        assert.ok(res.certificate.invalidated.includes(id), `${ctx} -> ${id}`);
      }
      prevRef = ref;
    }
  });
}
