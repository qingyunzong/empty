'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'award-cli-'));
  const data = {
    orders: [
      { order: 'O1', process: 'P1' },
      { order: 'O1', process: 'P2' },
    ],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M1', process: 'P2', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M3', process: 'P2', cert_expiry: null },
      { machine: 'M4', process: 'P2', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 8 },
      { machine: 'M2', shift_cost: 3 },
      { machine: 'M3', shift_cost: 1 },
      { machine: 'M4', shift_cost: 4 },
    ],
    budget: 8,
  };
  fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(data.orders));
  fs.writeFileSync(path.join(dir, 'machines.json'), JSON.stringify(data.machines));
  fs.writeFileSync(path.join(dir, 'costs.json'), JSON.stringify(data.costs));
  fs.writeFileSync(path.join(dir, 'budget.json'), JSON.stringify({ budget: data.budget }));
  return dir;
}

test('CLI candidates lists qualified machines per order', () => {
  const dir = makeDataDir();
  const result = run(['candidates', '--data', dir, '--order', 'O1']);
  assert.deepEqual(result.required, ['P1', 'P2']);
  // M3 has a null cert and must not appear.
  assert.deepEqual(
    result.candidates.map((c) => c.machine),
    ['M1', 'M2', 'M4'],
  );
});

test('CLI award picks the fewest-machine combination within budget', () => {
  const dir = makeDataDir();
  const result = run(['award', '--data', dir, '--order', 'O1']);
  assert.equal(result.status, 'awarded');
  assert.deepEqual(result.machines, ['M1']);
  assert.equal(result.total_cost, 8);
});

test('CLI apply-change reports withdrawal, diff and reassignment', () => {
  const dir = makeDataDir();
  const result = run([
    'apply-change', '--data', dir, '--order', 'O1',
    '--event', JSON.stringify({ type: 'budget', budget: 7 }),
  ]);
  assert.deepEqual(result.withdrawn.machines, ['M1']);
  assert.deepEqual(result.diff, { added: ['M2', 'M4'], removed: ['M1'] });
  assert.equal(result.reassignment.status, 'awarded');
  assert.deepEqual(result.reassignment.machines, ['M2', 'M4']);
});

test('CLI apply-change with cert revocation and infeasible outcome', () => {
  const dir = makeDataDir();
  const result = run([
    'apply-change', '--data', dir, '--order', 'O1',
    '--event', JSON.stringify({ type: 'revoke-cert', machine: 'M1' }),
    '--event', JSON.stringify({ type: 'revoke-cert', machine: 'M4' }),
  ]);
  // P2 loses its only valid cert (M3 is null) -> infeasible, never pending.
  assert.equal(result.reassignment.status, 'infeasible');
  assert.deepEqual(result.reassignment.certificate, {
    type: 'missing_capability',
    processes: ['P2'],
  });
});

test('CLI rejects unknown commands and missing events', () => {
  const dir = makeDataDir();
  assert.throws(() => run(['nope', '--data', dir, '--order', 'O1']), /unknown command/);
  assert.throws(() => run(['apply-change', '--data', dir, '--order', 'O1']), /requires at least one/);
});
