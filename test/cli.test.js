import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

const input = {
  lines: [{ id: 'L1', budgetPerShift: 1000 }],
  stations: [
    { id: 'DIAG', lineId: 'L1', capacityPerShift: 200 },
    { id: 'REPAIR', lineId: 'L1', capacityPerShift: 200 },
    { id: 'RECHECK', lineId: 'L1', capacityPerShift: 200 },
  ],
  orders: [
    {
      id: 'W1',
      route: [
        { station: 'DIAG', minutes: 100 },
        { station: 'REPAIR', minutes: 100 },
        { station: 'RECHECK', minutes: 100 },
      ],
    },
    {
      id: 'W2',
      priority: 'high',
      route: [
        { station: 'DIAG', minutes: 150 },
        { station: 'REPAIR', minutes: 150 },
        { station: 'RECHECK', minutes: 150 },
      ],
    },
    { id: 'W3', route: [{ station: 'DIAG', minutes: 50 }] },
  ],
  extraShifts: 1,
};

function writeInput(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rework-router-'));
  const file = join(dir, 'input.json');
  writeFileSync(file, JSON.stringify({ ...input, ...overrides }));
  return file;
}

test('cli run prints routes, deductions, preemptions and verification', () => {
  const { code, stdout, stderr } = main(['node', 'rework-router', 'run', writeInput()]);
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);

  assert.ok(result.verification.ok);
  // W2 (high) preempts W1 on the shared DIAG..RECHECK segment
  assert.equal(result.preemptions.length, 1);
  assert.equal(result.preemptions[0].by, 'W2');
  assert.equal(result.preemptions[0].victim, 'W1');
  assert.deepEqual(result.preemptions[0].segment, ['DIAG', 'REPAIR', 'RECHECK']);
  // after the extra shift the evicted W1 is re-routed
  const routed = result.routes.map((r) => r.orderId).sort();
  assert.deepEqual(routed, ['W1', 'W2', 'W3']);
  assert.equal(result.budgetDeductions.length, 3 + 3 + 1);
});

test('cli verify enumerates all permutations for <= 4 orders', () => {
  const { code, stdout, stderr } = main(['node', 'rework-router', 'verify', writeInput()]);
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.permutationsChecked, 6); // 3 orders -> 3!
  assert.ok(report.ok);
});

test('cli reports usage and input errors with exit code 2', () => {
  assert.equal(main(['node', 'rework-router']).code, 2);
  assert.equal(main(['node', 'rework-router', 'run', '/no/such/file.json']).code, 2);
  assert.equal(main(['node', 'rework-router', 'bogus', writeInput()]).code, 2);
});
