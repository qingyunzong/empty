'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, writeJson, runCli, runCliJson } = require('./helper');
const { merkleRoot } = require('../src/merkle');
const { sha256 } = require('../src/canon');

test('ingest rejects locked mutex overlap with exit 6', () => {
  const dir = tmpDir();
  const scenario = {
    name: 'bad-mutex',
    stations: [
      {
        id: 'A',
        link: 'L',
        battery: 10,
        windows: [{ id: 'a1', start: 0, end: 3, energy: 1, locked: true }],
      },
      {
        id: 'B',
        link: 'L',
        battery: 10,
        windows: [{ id: 'b1', start: 1, end: 4, energy: 1, locked: true }],
      },
    ],
    contracts: [],
  };
  const res = runCli(['ingest', writeJson(dir, 's.json', scenario), '--state', path.join(dir, 'st')]);
  assert.equal(res.code, 6);
  assert.match(res.stderr, /mutex overlap/);
});

test('ingest rejects negative battery with exit 6', () => {
  const dir = tmpDir();
  const scenario = {
    name: 'bad-energy',
    stations: [
      { id: 'A', battery: 5, windows: [{ id: 'a1', start: 0, end: 2, energy: -1 }] },
    ],
    contracts: [],
  };
  const res = runCli(['ingest', writeJson(dir, 's.json', scenario), '--state', path.join(dir, 'st')]);
  assert.equal(res.code, 6);
  assert.match(res.stderr, /negative battery/);

  const scenario2 = {
    name: 'bad-battery',
    stations: [{ id: 'A', battery: -3, windows: [] }],
    contracts: [],
  };
  const res2 = runCli(['ingest', writeJson(dir, 's2.json', scenario2), '--state', path.join(dir, 'st2')]);
  assert.equal(res2.code, 6);
  assert.match(res2.stderr, /negative battery/);
});

test('usage errors exit 2', () => {
  const dir = tmpDir();
  const res = runCli(['frobnicate']);
  assert.equal(res.code, 2);
  const res2 = runCli(['plan', '--state', path.join(dir, 'missing')]);
  assert.equal(res2.code, 2);
  assert.match(res2.stderr, /run ingest first/);
});

test('plan output carries a verifiable Merkle certificate', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'st');
  const scenario = {
    name: 'cert-demo',
    stations: [
      {
        id: 'A',
        battery: 2,
        windows: [
          { id: 'a1', start: 0, end: 2, energy: 1 },
          { id: 'a2', start: 2, end: 4, energy: 1 },
        ],
      },
    ],
    contracts: [{ id: 'CA', station: 'A', min: 2 }],
  };
  runCliJson(['ingest', writeJson(dir, 's.json', scenario), '--state', state]);
  const plan = runCliJson(['plan', '--state', state]);
  assert.equal(plan.certificate.algorithm, 'sha256');
  assert.equal(plan.certificate.leafCount, plan.certificate.leaves.length);
  assert.equal(merkleRoot(plan.certificate.leaves), plan.certificate.root);
  assert.equal(plan.planId, plan.certificate.root);
  assert.equal(merkleRoot([]), sha256('empty'));
});

test('unmet reasons are reported per cause', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'st');
  const scenario = {
    name: 'unmet-demo',
    stations: [
      // not enough windows at all
      { id: 'few', battery: 100, windows: [{ id: 'f1', start: 0, end: 1, energy: 1 }] },
      // battery caps below min
      {
        id: 'hungry',
        battery: 8,
        windows: [
          { id: 'h1', start: 0, end: 1, energy: 5 },
          { id: 'h2', start: 1, end: 2, energy: 5 },
          { id: 'h3', start: 2, end: 3, energy: 5 },
        ],
      },
      // loses the shared downlink
      { id: 'loser', link: 'DL', battery: 10, windows: [{ id: 'l1', start: 0, end: 2, energy: 1 }] },
      { id: 'winner', link: 'DL', battery: 10, windows: [{ id: 'w1', start: 1, end: 3, energy: 1 }] },
      // period quota caps below min
      {
        id: 'capped',
        battery: 100,
        windows: [
          { id: 'c1', start: 0, end: 1, energy: 1 },
          { id: 'c2', start: 1, end: 2, energy: 1 },
          { id: 'c3', start: 2, end: 3, energy: 1 },
        ],
      },
    ],
    contracts: [
      { id: 'Cfew', station: 'few', min: 3 },
      { id: 'Chungry', station: 'hungry', min: 2 },
      { id: 'Closer', station: 'loser', min: 1 },
      { id: 'Cwinner', station: 'winner', min: 1 },
      { id: 'Ccapped', station: 'capped', min: 3, period: 2, quota: 1 },
    ],
  };
  runCliJson(['ingest', writeJson(dir, 's.json', scenario), '--state', state]);
  const plan = runCliJson(['plan', '--state', state]);
  const reasons = new Map(plan.unmet.map((u) => [u.contract, u.reason]));
  assert.equal(reasons.get('Cfew'), 'insufficient-windows');
  assert.equal(reasons.get('Chungry'), 'insufficient-battery');
  // exactly one of the DL contenders is unmet, due to contention
  const contention = [reasons.get('Closer'), reasons.get('Cwinner')].filter(Boolean);
  assert.equal(contention.length, 1);
  assert.equal(contention[0], 'downlink-contention');
  assert.equal(reasons.get('Ccapped'), 'period-quota-cap');
  for (const u of plan.unmet) {
    assert.ok(u.deficit > 0 && u.scheduled < u.required);
  }
});

test('fault-blocked windows explain unmet contracts', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'st');
  const scenario = {
    name: 'fault-reason',
    stations: [
      {
        id: 'X',
        battery: 2,
        windows: [
          { id: 'x1', start: 0, end: 2, energy: 1 },
          { id: 'x2', start: 10, end: 12, energy: 1 },
        ],
      },
    ],
    contracts: [{ id: 'CX', station: 'X', min: 2 }],
  };
  runCliJson(['ingest', writeJson(dir, 's.json', scenario), '--state', state]);
  const fault = writeJson(dir, 'f.json', { id: 'F1', station: 'X', start: 5, end: 15 });
  const out = runCliJson(['fail', fault, '--state', state]);
  assert.equal(out.plan.unmet.length, 1);
  assert.equal(out.plan.unmet[0].reason, 'windows-unavailable-fault');
});
