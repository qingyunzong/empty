import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Ledger } from '../src/core.js';

// Independent brute-force reference implementation (shares no code with src/core.js).

function bruteNets(entries) {
  const totals = {};
  for (const { accountId, amount } of entries) {
    totals[accountId] = (totals[accountId] ?? 0) + amount;
  }
  return Object.keys(totals)
    .sort()
    .map((accountId) => ({ accountId, amount: totals[accountId] }));
}

function bruteStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(bruteStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${bruteStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function bruteCertificate(batchId, version, entries) {
  const body = { batchId, version, nets: bruteNets(entries) };
  return {
    ...body,
    hash: createHash('sha256').update(bruteStringify(body), 'utf8').digest('hex'),
  };
}

// Brute-force expected delta for a correction, derived by hand from the entry list.
function bruteDelta(correction, entries) {
  if (correction.op === 'add') {
    return { accountId: correction.accountId, amount: correction.amount };
  }
  const target = entries.find((entry) => entry.entryId === correction.entryId);
  assert.ok(target, `brute force could not find ${correction.entryId}`);
  if (correction.op === 'reverse') {
    return { accountId: target.accountId, amount: -target.amount };
  }
  return { accountId: target.accountId, amount: correction.amount - target.amount };
}

function runCrossCheck({ batchId, initialEntries, rounds, combos }) {
  for (let combo = 0; combo < combos; combo += 1) {
    const ledger = new Ledger();
    ledger.createBatch({
      batchId,
      requestId: `bf-create-${combo}`,
      entries: initialEntries.map(({ accountId, amount }) => ({ accountId, amount })),
    });
    // Expected history is rebuilt independently: ids e1..en in arrival order.
    const expectedEntries = initialEntries.map((entry, index) => ({
      entryId: `e${index + 1}`,
      accountId: entry.accountId,
      amount: entry.amount,
    }));
    rounds.forEach((round, roundIndex) => {
      const corrections = round(combo);
      ledger.applyCorrection({
        batchId,
        baseVersion: roundIndex + 1,
        requestId: `bf-corr-${combo}-${roundIndex}`,
        corrections,
      });
      for (const correction of corrections) {
        expectedEntries.push({
          entryId: `e${expectedEntries.length + 1}`,
          ...bruteDelta(correction, expectedEntries),
        });
      }
    });
    const confirmed = ledger.confirmBatch({ batchId, requestId: `bf-confirm-${combo}` });
    const expected = bruteCertificate(batchId, rounds.length + 1, expectedEntries);
    assert.deepEqual(
      confirmed.certificate,
      expected,
      `certificate mismatch for combo ${combo}`,
    );
  }
}

test('brute force: all sign combinations of add corrections (8 entries, 3 versions)', () => {
  // 2 initial entries + 3 corrections in v2 + 3 corrections in v3 = 8 entries.
  // Each correction amount is +/- magnitude, giving 2^6 = 64 combinations.
  const accounts = ['acc-a', 'acc-b', 'acc-c'];
  const magnitudes = [10, 20, 30, 40, 50, 60];
  const correctionsFor = (combo, offset) =>
    magnitudes.slice(offset, offset + 3).map((magnitude, i) => ({
      op: 'add',
      accountId: accounts[(offset + i) % accounts.length],
      amount: combo & (1 << (offset + i)) ? magnitude : -magnitude,
    }));
  runCrossCheck({
    batchId: 'BF-ADD',
    initialEntries: [
      { accountId: 'acc-a', amount: 500 },
      { accountId: 'acc-b', amount: -200 },
    ],
    rounds: [(combo) => correctionsFor(combo, 0), (combo) => correctionsFor(combo, 3)],
    combos: 1 << 6,
  });
});

test('brute force: mixed add/reverse/adjust corrections (8 entries, 3 versions)', () => {
  // 3 initial entries + 2 corrections in v2 + 3 corrections in v3 = 8 entries.
  // Sign bits flip add amounts and adjust targets: 2^5 = 32 combinations.
  const rounds = [
    (combo) => [
      { op: 'add', accountId: 'acc-x', amount: combo & 1 ? 70 : -70 },
      { op: 'reverse', entryId: combo & 2 ? 'e2' : 'e1' },
    ],
    (combo) => [
      { op: 'adjust', entryId: 'e3', amount: combo & 4 ? 0 : -90 },
      { op: 'add', accountId: 'acc-y', amount: combo & 8 ? 25 : -25 },
      { op: 'adjust', entryId: 'e1', amount: combo & 16 ? 400 : -400 },
    ],
  ];
  runCrossCheck({
    batchId: 'BF-MIX',
    initialEntries: [
      { accountId: 'acc-x', amount: 300 },
      { accountId: 'acc-y', amount: -120 },
      { accountId: 'acc-z', amount: 45 },
    ],
    rounds,
    combos: 1 << 5,
  });
});
