import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grossRequirements, netRequirements } from '../src/mrp.js';
import { enumeratePaths, referenceGross, referenceNet } from '../src/reference.js';
import { emptyState } from '../src/store.js';
import {
  scenario1Events, scenario1Gross, scenario1Net, scenario1Paths,
} from './fixtures.js';

function stateOf(events) {
  const state = emptyState();
  for (const e of events) {
    const coll = { workorder: 'workorders', bom: 'bom', inventory: 'inventory' }[e.entity];
    const k = e.entity === 'workorder' ? e.key.id
      : e.entity === 'bom' ? `${e.key.parent} ${e.key.component}`
      : e.key.component;
    state[coll][k] = e.entity === 'workorder' ? { id: e.key.id, ...e.value }
      : e.entity === 'bom' ? { parent: e.key.parent, component: e.key.component, ...e.value }
      : { component: e.key.component, ...e.value };
  }
  return state;
}

test('scenario 1: multi-level shared components gross requirements', () => {
  const state = stateOf(scenario1Events);
  assert.deepEqual(grossRequirements(state), scenario1Gross);
});

test('scenario 1: net requirements, null inventory stays null', () => {
  const state = stateOf(scenario1Events);
  const { net, inventory } = netRequirements(state);
  assert.deepEqual(net, scenario1Net);
  assert.equal(inventory.C, null);
  assert.equal(net.C, null, 'unknown inventory must not be treated as 0');
});

test('scenario 1: reference path enumeration matches reference values', () => {
  const state = stateOf(scenario1Events);
  const paths = enumeratePaths(state);
  assert.equal(paths.length, 3);
  const actual = paths.map((p) => ({
    order: p.order,
    path: p.nodes,
    quantities: Object.fromEntries(p.nodes.slice(1).map((component, i) => [
      component,
      p.usages.slice(0, i + 1).reduce((a, b) => a * b, 1) * state.workorders[p.order].qty,
    ])),
  }));
  assert.deepEqual(actual, scenario1Paths);
});

test('reference algorithm recomputation equals relational engine', () => {
  const state = stateOf(scenario1Events);
  assert.deepEqual(referenceGross(state), grossRequirements(state));
  assert.deepEqual(referenceNet(state).net, netRequirements(state).net);
});

test('reference path limit (>20) raises an error', () => {
  // Chain of 25 single-child levels produces 1 path; build a wide BOM instead:
  // root with 21 leaf children -> 21 paths > 20.
  const state = emptyState();
  state.workorders.WO = { id: 'WO', product: 'R', qty: 1 };
  for (let i = 0; i < 21; i += 1) {
    state.bom[`R c${i}`] = { parent: 'R', component: `c${i}`, usage: 1 };
  }
  assert.throws(() => enumeratePaths(state), /path limit exceeded/);
});

test('BOM cycle is detected', () => {
  const state = emptyState();
  state.workorders.WO = { id: 'WO', product: 'X', qty: 1 };
  state.bom['X Y'] = { parent: 'X', component: 'Y', usage: 1 };
  state.bom['Y X'] = { parent: 'Y', component: 'X', usage: 1 };
  assert.throws(() => grossRequirements(state), /cycle/);
  assert.throws(() => enumeratePaths(state), /cycle/);
});

test('missing inventory row means unknown net (left join null)', () => {
  const state = emptyState();
  state.workorders.WO = { id: 'WO', product: 'P', qty: 2 };
  state.bom['P C'] = { parent: 'P', component: 'C', usage: 3 };
  const { net, inventory } = netRequirements(state);
  assert.equal(inventory.C, null);
  assert.equal(net.C, null);
});
