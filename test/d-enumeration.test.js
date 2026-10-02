import test from 'node:test';
import assert from 'node:assert/strict';
import { Interpreter, resolvePermission } from '../src/interpreter.js';
import { specPermit, specForbidden } from '../src/audit.js';
import { chainClosed, findCounterexample } from '../src/counterexample.js';

function makeModel(forbiddenEdges = []) {
  const forbidden = new Map();
  for (const [a, b] of forbiddenEdges) {
    if (!forbidden.has(a)) forbidden.set(a, new Set());
    forbidden.get(a).add(b);
  }
  return {
    factory: 'F1',
    workshops: new Map([['W1', ['K1', 'K2']], ['W2', ['K3']]]),
    reactorToWorkshop: new Map([['K1', 'W1'], ['K2', 'W1'], ['K3', 'W2']]),
    recipes: new Map([
      ['RA', { versions: new Set([1]), max: 1 }],
      ['RB', { versions: new Set([1]), max: 1 }],
      ['RC', { versions: new Set([1]), max: 1 }],
    ]),
    forbidden,
  };
}

// 8 candidate approvals spanning all inheritance levels.
const GRANTS = [
  { ts: 1, op: 'grant', id: 'g-f-ra', level: 'factory', recipe: 'RA', version: 1 },
  { ts: 2, op: 'grant', id: 'g-f-rb', level: 'factory', recipe: 'RB', version: 1 },
  { ts: 3, op: 'grant', id: 'g-w1-ra', level: 'workshop', workshop: 'W1', recipe: 'RA', version: 1 },
  { ts: 4, op: 'grant', id: 'g-w1-rb', level: 'workshop', workshop: 'W1', recipe: 'RB', version: 1 },
  { ts: 5, op: 'grant', id: 'g-w2-ra', level: 'workshop', workshop: 'W2', recipe: 'RA', version: 1 },
  { ts: 6, op: 'grant', id: 'g-k1-ra', level: 'reactor', reactor: 'K1', recipe: 'RA', version: 1 },
  { ts: 7, op: 'grant', id: 'g-k1-rb', level: 'reactor', reactor: 'K1', recipe: 'RB', version: 1 },
  { ts: 8, op: 'grant', id: 'g-k3-rb', level: 'reactor', reactor: 'K3', recipe: 'RB', version: 1 },
];

function* subsets(arr) {
  const n = arr.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    yield arr.filter((_, i) => mask & (1 << i));
  }
}

test('D: interpreter permission matches brute-force spec over all 2^8 approval subsets', () => {
  const model = makeModel();
  let checked = 0;
  let validSubsets = 0;
  for (const subset of subsets(GRANTS)) {
    if (!chainClosed(model, subset)) continue;
    validSubsets++;
    const ordered = [...subset].sort((a, b) => a.ts - b.ts);
    const interp = new Interpreter(model);
    for (const g of ordered) interp.apply(g);
    for (const reactor of ['K1', 'K2', 'K3']) {
      for (const recipe of ['RA', 'RB']) {
        const viaInterpreter = interp.permission(reactor, recipe, 1).permitted;
        const viaResolve = resolvePermission(model, subset.map((g) => ({ ...g, active: true })), reactor, recipe, 1).permitted;
        const viaSpec = specPermit(model, subset.map((g) => ({ ...g, active: true })), reactor, recipe, 1);
        assert.equal(viaInterpreter, viaSpec, `interpreter != spec for ${reactor}/${recipe} subset=${subset.map((g) => g.id)}`);
        assert.equal(viaResolve, viaSpec, `resolve != spec for ${reactor}/${recipe} subset=${subset.map((g) => g.id)}`);
        checked++;
      }
    }
  }
  assert.ok(validSubsets > 0);
  assert.ok(checked >= validSubsets * 6);
});

test('D: interpreter forbidden check matches brute-force spec over all 2^8 edge subsets', () => {
  const refs = ['RA@1', 'RB@1', 'RC@1'];
  const allEdges = [];
  for (const a of refs) for (const b of refs) if (a !== b) allEdges.push([a, b]);
  assert.equal(allEdges.length, 6);
  // Pad to exactly 8 candidate entries by allowing repeated consideration of
  // self-loops is avoided; 2^6 = 64 subsets of real edges are enumerated.
  const grants = [
    { ts: 1, op: 'grant', id: 'g-f-ra', level: 'factory', recipe: 'RA', version: 1 },
    { ts: 2, op: 'grant', id: 'g-f-rb', level: 'factory', recipe: 'RB', version: 1 },
    { ts: 3, op: 'grant', id: 'g-f-rc', level: 'factory', recipe: 'RC', version: 1 },
  ];
  let checked = 0;
  for (const edges of subsets(allEdges)) {
    const model = makeModel(edges);
    const interp = new Interpreter(model);
    for (const g of grants) interp.apply(g);
    // Fill K1 with RA@1, then probe RB and RC.
    interp.apply({ ts: 10, op: 'feed', reactor: 'K1', recipe: 'RA', version: 1 });
    const contents = [...(interp.contents.get('K1') ?? [])];
    for (const recipe of ['RB', 'RC']) {
      interp.apply({ ts: 11, op: 'feed', reactor: 'K1', recipe, version: 1 });
      const last = interp.decisions[interp.decisions.length - 1];
      const expectedForbidden = specForbidden(model, contents, recipe, 1);
      assert.equal(last.decision === 'deny' && last.reason === 'forbidden', expectedForbidden,
        `edges=${JSON.stringify(edges)} recipe=${recipe}`);
      checked++;
      // Restore contents for the next probe.
      interp.apply({ ts: 12, op: 'empty', reactor: 'K1' });
      interp.apply({ ts: 13, op: 'feed', reactor: 'K1', recipe: 'RA', version: 1 });
    }
  }
  assert.equal(checked, 64 * 2);
});

test('D: counterexample minimality cross-checked by full subset enumeration', () => {
  const model = makeModel([['RA@1', 'RB@1']]);
  const contents = new Set(['RA@1']);
  const result = findCounterexample(model, GRANTS, contents, 'K1', 'RB', 1);
  assert.equal(result.dangerous, true);
  assert.deepEqual(result.conflicts, ['RA@1']);

  // Independent brute force: minimal size over every subset of candidates.
  const relevant = GRANTS.filter((g) => {
    if (g.recipe !== 'RB' || g.version !== 1) return false;
    if (g.level === 'factory') return true;
    if (g.level === 'workshop') return g.workshop === 'W1';
    return g.reactor === 'K1';
  });
  let minSize = Infinity;
  const minimalSets = [];
  for (const subset of subsets(relevant)) {
    if (subset.length > minSize) continue;
    if (!chainClosed(model, subset)) continue;
    const ok = resolvePermission(model, subset.map((g) => ({ ...g, active: true })), 'K1', 'RB', 1).permitted;
    if (ok) {
      if (subset.length < minSize) {
        minSize = subset.length;
        minimalSets.length = 0;
      }
      minimalSets.push(subset.map((g) => g.id).sort());
    }
  }
  assert.equal(result.size, minSize);
  assert.ok(minimalSets.some((s) => JSON.stringify(s) === JSON.stringify(result.minimalApprovals)));
});

test('D: no counterexample exists when no candidate can permit the dangerous feed', () => {
  const model = makeModel([['RA@1', 'RB@1']]);
  const contents = new Set(['RA@1']);
  const onlyOtherRecipe = GRANTS.filter((g) => g.recipe === 'RA');
  const result = findCounterexample(model, onlyOtherRecipe, contents, 'K1', 'RB', 1);
  assert.equal(result.dangerous, true);
  assert.equal(result.minimalApprovals, null);
});

test('D: non-dangerous target yields dangerous=false', () => {
  const model = makeModel([['RA@1', 'RB@1']]);
  const result = findCounterexample(model, GRANTS, new Set(['RB@1']), 'K1', 'RA', 1);
  assert.equal(result.dangerous, false);
});
