import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runJe, readJson, mulberry32 } from './helpers.js';

// Acceptance 5: 100 random events cross-checked against an independent
// balance sheet computed in the test itself.
test('acceptance 5: 100 random events match an independent balance sheet', () => {
  const rand = mulberry32(20251003);
  const accounts = ['cash', 'ar', 'ap', 'revenue', 'fees', 'supplies', 'equity'];
  const pick = () => accounts[Math.floor(rand() * accounts.length)];
  const amount = () => 1 + Math.floor(rand() * 100000) / 100;

  const NBATCH = 10;
  const PER_EVENTS = 10;

  const dsl = [
    'period "2025-01"',
    'template transfer(from, to, amount) {',
    '  debit from $amount',
    '  credit to $amount',
    '  balance debit == credit',
    '}',
    'template sale(gross, fee) {',
    '  debit cash $gross',
    '  credit revenue $gross - $fee',
    '  credit fees $fee',
    '}',
    ...Array.from({ length: NBATCH }, (_, i) => `batch R${i} { period "2025-01" allow transfer, sale }`),
    ''
  ].join('\n');

  const batches = [];
  const expected = {}; // independent balance sheet
  const apply = (account, dc, amt) => {
    expected[account] = (expected[account] || 0) + (dc === 'D' ? amt : -amt);
  };

  for (let b = 0; b < NBATCH; b++) {
    const events = [];
    for (let e = 0; e < PER_EVENTS; e++) {
      if (rand() < 0.5) {
        let from = pick();
        let to = pick();
        while (to === from) to = pick();
        const amt = amount();
        events.push({ template: 'transfer', args: { from, to, amount: amt } });
        apply(from, 'D', amt);
        apply(to, 'C', amt);
      } else {
        const gross = amount();
        const fee = Math.floor(rand() * Math.floor(gross * 100)) / 100;
        events.push({ template: 'sale', args: { gross, fee } });
        apply('cash', 'D', gross);
        apply('revenue', 'C', gross - fee);
        apply('fees', 'C', fee);
      }
    }
    batches.push({ id: `R${b}`, period: '2025-01', events });
  }
  assert.equal(batches.flatMap((b) => b.events).length, 100);

  const dir = tmpdir();
  const jeFile = path.join(dir, 'random.je');
  const eventsFile = path.join(dir, 'events.json');
  fs.writeFileSync(jeFile, dsl);
  fs.writeFileSync(eventsFile, JSON.stringify({ batches }));

  const db = path.join(dir, 'db');
  const r = runJe(['run', jeFile, eventsFile, '--db', db]);
  assert.equal(r.code, 0, r.stderr);

  const actual = readJson(path.join(db, 'index.json')).balances['2025-01'];
  assert.deepEqual(actual, expected);

  // Ledger must globally balance: sum of all signed balances is zero.
  const total = Object.values(actual).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total) < 1e-6, `ledger out of balance by ${total}`);
});
