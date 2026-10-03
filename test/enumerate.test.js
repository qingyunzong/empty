import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateOptimal } from '../src/enumerate.js';
import { initialDyn, computeTimes, validate } from '../src/model.js';
import { cli, tmpdir, initPair, expectOk } from './helpers.js';

function chainPlan() {
  return {
    budget: 100,
    machines: [
      { id: 'M1', caps: ['cut', 'weld'] },
      { id: 'M2', caps: ['cut', 'weld'] },
    ],
    jobs: [
      { id: 'J1', due: 14, weight: 2, ops: [
        { id: 'o1', cap: 'cut', dur: 3 },
        { id: 'o2', cap: 'weld', dur: 2 },
        { id: 'o3', cap: 'cut', dur: 4 },
        { id: 'o4', cap: 'weld', dur: 1 },
      ] },
      { id: 'J2', due: 12, weight: 3, ops: [
        { id: 'o1', cap: 'weld', dur: 2 },
        { id: 'o2', cap: 'cut', dur: 3 },
        { id: 'o3', cap: 'weld', dur: 2 },
        { id: 'o4', cap: 'cut', dur: 2 },
      ] },
    ],
  };
}

test('independent enumeration finds the known optimum (n=2, single machine)', () => {
  const plan = {
    budget: 100,
    machines: [{ id: 'M1', caps: ['x'] }],
    jobs: [
      { id: 'J1', due: 3, weight: 1, ops: [{ id: 'o1', cap: 'x', dur: 3 }] },
      { id: 'J2', due: 4, weight: 1, ops: [{ id: 'o1', cap: 'x', dur: 5 }] },
    ],
  };
  const opt = enumerateOptimal(plan, initialDyn(plan));
  assert.equal(opt.cost, 4, 'J1 before J2: 0 + max(0,8-4) = 4');
  assert.deepEqual(opt.order.M1, ['J1.o1', 'J2.o1']);
});

test('n=8: enumerated optimum is achievable and lower-bounds every synced schedule', () => {
  const plan = chainPlan();
  const dyn0 = initialDyn(plan);
  const opt = enumerateOptimal(plan, dyn0);
  assert.ok(Number.isFinite(opt.cost));

  const optDyn = { order: opt.order, cancelled: [], addedOps: [] };
  const optTimes = computeTimes(plan, optDyn);
  assert.equal(optTimes.cost, opt.cost, 'enumerated order realizes the enumerated cost');
  assert.equal(validate(plan, optDyn).violations.length, 0);

  const initialCost = computeTimes(plan, dyn0).cost;
  assert.ok(initialCost >= opt.cost, 'optimum lower-bounds the initial schedule');

  const root = tmpdir();
  const { a, b } = initPair(root, plan);
  expectOk(cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J2.o1","machine":"M2","index":0}']));
  expectOk(cli(['apply', '--dir', b, '--change', '{"type":"move","op":"J1.o2","machine":"M2","index":1}']));
  assert.equal(cli(['sync', '--a', a, '--b', b]).code, 0);
  const cert = JSON.parse(expectOk(cli(['export-cert', '--dir', a])).stdout);
  assert.ok(cert.cost >= opt.cost, `converged cost ${cert.cost} >= optimal ${opt.cost}`);
  assert.ok(cert.cost <= plan.budget, 'converged schedule respects the penalty budget');
});

test('enumeration respects machine capability restrictions', () => {
  const plan = {
    budget: 100,
    machines: [
      { id: 'M1', caps: ['cut'] },
      { id: 'M2', caps: ['weld'] },
    ],
    jobs: [
      { id: 'J1', due: 10, weight: 1, ops: [
        { id: 'o1', cap: 'cut', dur: 2 },
        { id: 'o2', cap: 'weld', dur: 2 },
      ] },
    ],
  };
  const opt = enumerateOptimal(plan, initialDyn(plan));
  assert.equal(opt.cost, 0);
  assert.deepEqual(opt.order.M1, ['J1.o1']);
  assert.deepEqual(opt.order.M2, ['J1.o2']);
});
