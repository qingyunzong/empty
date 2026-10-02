import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, runCli, writeScenario } from './helpers.js';
import { proofOf } from '../src/proof.js';

function craftState(dir, scenario, rounds) {
  fs.mkdirSync(path.join(dir, 'rounds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario));
  for (const round of rounds) {
    const rd = path.join(dir, 'rounds', `round-${String(round.round).padStart(4, '0')}`);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'allocations.json'), JSON.stringify(round));
    fs.writeFileSync(path.join(rd, 'commit.marker'), `${proofOf(round)}\n`);
  }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ committed: rounds.length, proof: null }));
}

const scenario = {
  capacity: 5,
  agingLimit: null,
  institutions: { A: { quota: 3 }, B: { quota: 5 } },
  batches: [
    { id: 'a1', institution: 'A', priority: 0, amount: 8, arrivalRound: 1, group: null },
    { id: 'g1a', institution: 'B', priority: 0, amount: 2, arrivalRound: 1, group: 'g1' },
    { id: 'g1b', institution: 'B', priority: 0, amount: 2, arrivalRound: 1, group: 'g1' },
  ],
};

test('verify reports WINDOW_FULL when a round exceeds capacity', () => {
  const dir = tmpDir();
  craftState(dir, scenario, [
    { round: 1, used: 6, allocations: [{ batch: 'a1', institution: 'A', amount: 3 }, { batch: 'g1a', institution: 'B', amount: 2, group: 'g1' }, { batch: 'g1b', institution: 'B', amount: 2, group: 'g1' }] },
  ]);
  const r = runCli(['verify', '--state', dir]);
  assert.equal(r.status, 11);
  assert.ok(r.stderr.includes('WINDOW_FULL'));
});

test('verify reports QUOTA when an institution exceeds its round quota', () => {
  const dir = tmpDir();
  craftState(dir, scenario, [
    { round: 1, used: 4, allocations: [{ batch: 'a1', institution: 'A', amount: 4 }] },
  ]);
  const r = runCli(['verify', '--state', dir]);
  assert.equal(r.status, 12);
  assert.ok(r.stderr.includes('QUOTA'));
});

test('verify reports ATOMIC_SPLIT when a group is split across rounds', () => {
  const dir = tmpDir();
  craftState(dir, scenario, [
    { round: 1, used: 2, allocations: [{ batch: 'g1a', institution: 'B', amount: 2, group: 'g1' }] },
    { round: 2, used: 2, allocations: [{ batch: 'g1b', institution: 'B', amount: 2, group: 'g1' }] },
  ]);
  const r = runCli(['verify', '--state', dir]);
  assert.equal(r.status, 10);
  assert.ok(r.stderr.includes('ATOMIC_SPLIT'));
});

test('plan rejects an atomic group larger than the window with ATOMIC_SPLIT', () => {
  const dir = tmpDir();
  const input = writeScenario(dir, {
    capacity: 5,
    institutions: { A: { quota: 10 } },
    batches: [{ id: 'g1', institution: 'A', amount: 6, atomic: true }],
  });
  const r = runCli(['plan', '--input', input, '--state', dir]);
  assert.equal(r.status, 10);
  assert.ok(r.stderr.includes('ATOMIC_SPLIT'));
});

test('plan rejects an undrainable zero-quota institution with QUOTA', () => {
  const dir = tmpDir();
  const input = writeScenario(dir, {
    capacity: 5,
    institutions: { A: { quota: 0 } },
    batches: [{ id: 'a1', institution: 'A', amount: 1 }],
  });
  const r = runCli(['plan', '--input', input, '--state', dir]);
  assert.equal(r.status, 12);
  assert.ok(r.stderr.includes('QUOTA'));
});
