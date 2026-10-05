import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, lines, runCli, withTempFiles } from './helpers.js';

const HIST_A = lines(
  { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
  { id: 'a2', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' }
);
const HIST_B = lines(
  { id: 'b1', device: 'B', ts: 1, op: 'sync', with: 'A', mark: 'm1' },
  { id: 'b2', device: 'B', ts: 2, op: 'set_count', plot: 'P2', species: 'S1', tier: 1 }
);

test('CLI exit 0 with verdict JSON on a clean merge', () => {
  withTempFiles({ 'config.json': JSON.stringify(CONFIG), 'A.jsonl': HIST_A, 'B.jsonl': HIST_B }, (p) => {
    const r = runCli(['--config', p['config.json'], p['A.jsonl'], p['B.jsonl']]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.verdict, 'LINEARIZABLE_MODEL');
    assert.equal(r.json.matrix.P1.S1, 2);
    assert.equal(r.json.matrix.P2.S1, 1);
  });
});

test('CLI exit 2 on INVALID_HISTORY', () => {
  withTempFiles({ 'config.json': JSON.stringify(CONFIG), 'A.jsonl': '{"bad json\n' }, (p) => {
    const r = runCli(['--config', p['config.json'], p['A.jsonl']]);
    assert.equal(r.status, 2);
    assert.equal(r.json.verdict, 'INVALID_HISTORY');
  });
});

test('CLI exit 6 on CONFLICT (causal cycle)', () => {
  const a = lines(
    { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 1 },
    { id: 'sa1', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' },
    { id: 'a2', device: 'A', ts: 3, op: 'set_count', plot: 'P1', species: 'S2', tier: 1 },
    { id: 'sa2', device: 'A', ts: 4, op: 'sync', with: 'B', mark: 'm2' }
  );
  const b = lines(
    { id: 'sb2', device: 'B', ts: 1, op: 'sync', with: 'A', mark: 'm2' },
    { id: 'b2', device: 'B', ts: 2, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
    { id: 'sb1', device: 'B', ts: 3, op: 'sync', with: 'A', mark: 'm1' }
  );
  withTempFiles({ 'config.json': JSON.stringify(CONFIG), 'A.jsonl': a, 'B.jsonl': b }, (p) => {
    const r = runCli(['--config', p['config.json'], p['A.jsonl'], p['B.jsonl']]);
    assert.equal(r.status, 6);
    assert.equal(r.json.verdict, 'CONFLICT');
    assert.equal(r.json.reason, 'causal_cycle');
    assert.equal(r.json.cycle.length, 4);
  });
});

test('CLI exit 4 on PENDING (budget exhausted) and no conflict claimed', () => {
  withTempFiles({ 'config.json': JSON.stringify(CONFIG), 'A.jsonl': HIST_A, 'B.jsonl': HIST_B }, (p) => {
    const r = runCli(['--config', p['config.json'], '--budget', '1', p['A.jsonl'], p['B.jsonl']]);
    assert.equal(r.status, 4);
    assert.equal(r.json.verdict, 'PENDING');
    assert.ok(!('cycle' in r.json) && !('pair' in r.json), 'PENDING must not judge conflict');
  });
});
