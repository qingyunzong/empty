import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../src/index.js';

const LOTS = { cash: '0', lots: [{ id: 'L1', security: 'AAPL', qty: '100', date: '2024-01-05' }] };

// Acceptance 1: split, withdraw, restate. History is kept; the reversal is a
// generated inverse corporate action, and the restated version applies after.
test('split -> reverse -> restate keeps full history', () => {
  const vm = runSource(
    `
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
reverse S1
restate S1 { ratio 1/4 version 2 }
`,
    LOTS,
  );
  const positions = vm.positions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].qty.toString(), '400'); // 100 * 2, undone, then * 4

  const types = vm.journal.map((j) => j.type);
  assert.deepEqual(types, ['APPLY', 'REVERSE', 'RESTATED', 'APPLY']);
  assert.equal(vm.journal[0].version, 1); // original entry preserved
  assert.equal(vm.journal[1].id, 'S1#rev1'); // inverse action generated, not deleted
  assert.equal(vm.journal[2].fromVersion, 1);
  assert.equal(vm.journal[2].toVersion, 2);
  assert.equal(vm.journal[3].version, 2);
});

// Acceptance 2: sell part of a lot, then reverse. The shortfall books a
// payable instead of driving the position negative.
test('reverse after partial sell books payable, never negative positions', () => {
  const vm = runSource(
    `
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
sell AAPL 150 on 2024-06-20
reverse S1
`,
    LOTS,
  );
  assert.equal(vm.positions().length, 0); // 200 - 150 sold - 50 clawed back = 0
  assert.equal(vm.receivables.length, 1);
  assert.equal(vm.receivables[0].security, 'AAPL');
  assert.equal(vm.receivables[0].qty, '-50'); // payable for the sold granted shares
  assert.ok(vm.lots.every((l) => l.qty.sign() >= 0));
});

test('same security + same ex-date applies order by version then hash', () => {
  const vm = runSource(
    `
action D2 { security AAPL kind dividend cash $1 exdate 2024-06-10 version 2 }
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
action D1 { security AAPL kind dividend cash $1 exdate 2024-06-10 version 1 }
apply D2
apply S1
apply D1
`,
    LOTS,
  );
  const order = vm.journal.filter((j) => j.type === 'APPLY').map((j) => j.id);
  // version 1 entries first; S1 vs D1 same version -> hash tie-break
  const first = [order[0], order[1]].sort();
  assert.deepEqual(first, ['D1', 'S1']);
  assert.equal(order[2], 'D2');
  // hash order between D1 and S1 is deterministic
  const hashes = vm.journal.filter((j) => j.type === 'APPLY' && j.version === 1).map((j) => j.hash);
  assert.ok(hashes[0] <= hashes[1]);
});

test('scopes are isolated per security', () => {
  const vm = runSource(
    `
action D1 { security AAPL kind dividend cash $3 exdate 2024-06-10 version 1 }
apply D1
`,
    {
      lots: [
        { id: 'L1', security: 'AAPL', qty: '10', date: '2024-01-01' },
        { id: 'L2', security: 'MSFT', qty: '7', date: '2024-01-01' },
      ],
    },
  );
  assert.equal(vm.cash.toString(), '30');
  assert.equal(vm.lots.find((l) => l.id === 'L2').qty.toString(), '7');
});

test('multiple actions on one security compose in order', () => {
  const vm = runSource(
    `
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
action S2 { security AAPL kind split ratio 2/3 exdate 2024-07-01 version 1 }
apply S1
apply S2
`,
    LOTS,
  );
  assert.equal(vm.positions()[0].qty.toString(), '300'); // 100 * 2 * 3/2
});

test('dividend reversal debits cash; tender reversal restores shares', () => {
  const vm = runSource(
    `
action D1 { security AAPL kind dividend cash $2 exdate 2024-06-10 version 1 }
action T1 { security AAPL kind tender cash $150 exdate 2024-07-01 version 1 }
apply D1
apply T1
reverse T1
reverse D1
`,
    LOTS,
  );
  assert.equal(vm.cash.toString(), '0');
  assert.equal(vm.positions()[0].qty.toString(), '100');
});

test('cash-in-lieu pays cash for fractional shares', () => {
  const vm = runSource(
    `
action S1 { security AAPL kind split ratio 2/3 cashinlieu $10 exdate 2024-06-10 version 1 }
apply S1
`,
    { lots: [{ id: 'L1', security: 'AAPL', qty: '3', date: '2024-01-01' }] },
  );
  assert.equal(vm.positions()[0].qty.toString(), '4'); // 4.5 -> 4 whole shares
  assert.equal(vm.cash.toString(), '5'); // 0.5 * $10
});

test('E_LOT on oversell, E_REVERSE on double reverse, E_DATE on bad dates', () => {
  assert.throws(
    () => runSource('sell AAPL 500 on 2024-06-20', LOTS),
    (e) => e.code === 'E_LOT',
  );
  assert.throws(
    () =>
      runSource(
        `action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
reverse S1
reverse S1`,
        LOTS,
      ),
    (e) => e.code === 'E_REVERSE',
  );
  assert.throws(
    () => runSource('action S1 { security AAPL kind split ratio 1/2 exdate 2024-13-01 version 1 }', LOTS),
    (e) => e.code === 'E_DATE',
  );
});

test('restate cannot move ex-date earlier (E_DATE) and version must increase (E_REVERSE)', () => {
  assert.throws(
    () =>
      runSource(
        `action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
restate S1 { ratio 1/3 exdate 2024-06-01 version 2 }`,
        LOTS,
      ),
    (e) => e.code === 'E_DATE',
  );
  assert.throws(
    () =>
      runSource(
        `action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
restate S1 { ratio 1/3 version 1 }`,
        LOTS,
      ),
    (e) => e.code === 'E_REVERSE',
  );
});

test('restate while old version still applied reverses it first', () => {
  const vm = runSource(
    `
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
restate S1 { ratio 1/4 version 2 }
`,
    LOTS,
  );
  assert.equal(vm.positions()[0].qty.toString(), '400'); // 100*2 -> undo -> *4
  const types = vm.journal.map((j) => j.type);
  assert.deepEqual(types, ['APPLY', 'REVERSE', 'RESTATED', 'APPLY']);
});
