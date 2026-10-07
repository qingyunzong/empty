'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { joinStreams } = require('../lib/join');

const trade = (orderId, symbol, qty, price, ts, line) =>
  ({ orderId, symbol, qty, price, ts, line });
const cancel = (orderId, symbol, qty, ts, line) =>
  ({ orderId, symbol, qty, ts, line });

// Deterministic PRNG for shuffles.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(rows, rand) {
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  // Reassign line numbers to match the shuffled file positions.
  return copy.map((row, idx) => ({ ...row, line: idx + 1 }));
}

test('A: out-of-order input on both sides equals sorted reference', () => {
  const trades = [
    trade('o1', 'A', 100, 500, 1_000, 1),
    trade('o2', 'A', 40, 510, 12_000, 2),
    trade('o3', 'B', 10, 99, 8_000, 3),
    trade('o4', 'B', 25, 101, 21_000, 4),
    trade('o5', 'A', 60, 505, 5_000, 5),
  ];
  const cancels = [
    cancel('o1', 'A', 30, 2_000, 1),
    cancel('o1', 'A', 20, 11_000, 2),
    cancel('o5', 'A', 60, 6_000, 3),
    cancel('o4', 'B', 10, 22_000, 4),
    cancel('o2', 'A', 15, 3_000, 5), // earlier window than its trade: orphan
    cancel('zz', 'A', 7, 4_000, 6), // unknown order: orphan
  ];

  // Proofs commit to physical line numbers, so the comparison projects
  // rows down to their semantic content (key, qty, window, lateness).
  const project = (result) => ({
    rows: result.rows
      .map(({ orderId, symbol, qty, win, late }) => ({ orderId, symbol, qty, win, late }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    orphans: result.orphans
      .map(({ orderId, symbol, qty, win, reason }) => ({ orderId, symbol, qty, win, reason }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    symbols: result.symbols,
  });
  const reference = project(joinStreams(
    [...trades].sort((a, b) => a.ts - b.ts).map((t, i) => ({ ...t, line: i + 1 })),
    [...cancels].sort((a, b) => a.ts - b.ts).map((c, i) => ({ ...c, line: i + 1 })),
  ));

  for (let seed = 1; seed <= 25; seed += 1) {
    const rand = mulberry32(seed);
    const result = project(joinStreams(shuffled(trades, rand), shuffled(cancels, rand)));
    assert.deepEqual(result, reference, `semantic result differs for seed ${seed}`);
  }
});

test('B: partial cancels across two windows', () => {
  const result = joinStreams(
    [trade('o1', 'A', 100, 500, 1_000, 1)],
    [cancel('o1', 'A', 40, 2_000, 1), cancel('o1', 'A', 30, 11_000, 2)],
  );
  assert.equal(result.fills.length, 1);
  assert.deepEqual(
    result.fills.map(({ orderId, symbol, qty, win }) => ({ orderId, symbol, qty, win })),
    [{ orderId: 'o1', symbol: 'A', qty: 60, win: 0 }],
  );
  assert.equal(result.lateJoins.length, 1);
  assert.deepEqual(
    result.lateJoins.map(({ orderId, qty, win, late }) => ({ orderId, qty, win, late })),
    [{ orderId: 'o1', qty: -30, win: 1, late: true }],
  );
  assert.deepEqual(result.symbols, { A: { qty: 30, amountCents: 15_000 } });
  assert.deepEqual(result.orphans, []);
});

test('C: orphan cancels listed separately, never negative fills', () => {
  const result = joinStreams(
    [trade('o1', 'A', 50, 100, 1_000, 1)],
    [
      cancel('nope', 'A', 10, 2_000, 1), // unknown order
      cancel('o1', 'A', 80, 3_000, 2),   // 50 matched, 30 orphan
    ],
  );
  assert.deepEqual(result.orphans, [
    { orderId: 'nope', symbol: 'A', qty: 10, ts: 2_000, win: 0, line: 1, reason: 'unknown-order' },
    { orderId: 'o1', symbol: 'A', qty: 30, ts: 3_000, win: 0, line: 2, reason: 'insufficient-open-qty' },
  ]);
  for (const row of result.rows) {
    assert.ok(row.late || row.qty >= 0, 'non-late fills must not be negative');
  }
  assert.deepEqual(result.symbols, { A: { qty: 0, amountCents: 0 } });
});

test('cancel earlier than trade within the same window still matches', () => {
  const result = joinStreams(
    [trade('o1', 'A', 100, 500, 9_000, 1)],
    [cancel('o1', 'A', 25, 1_000, 1)],
  );
  assert.equal(result.fills[0].qty, 75);
  assert.equal(result.lateJoins.length, 0);
  assert.deepEqual(result.orphans, []);
});

test('duplicate cancel takes effect only once', () => {
  const result = joinStreams(
    [trade('o1', 'A', 100, 500, 1_000, 1)],
    [
      cancel('o1', 'A', 40, 2_000, 1),
      cancel('o1', 'A', 40, 2_000, 2), // exact duplicate
      cancel('o1', 'A', 40, 2_000, 3), // exact duplicate
    ],
  );
  assert.equal(result.fills[0].qty, 60);
  assert.equal(result.stats.duplicateCancels, 2);
  assert.deepEqual(result.orphans, []);
});

test('remainder stays open to cancels in later windows (FIFO across trades)', () => {
  const result = joinStreams(
    [trade('o1', 'A', 50, 100, 1_000, 1), trade('o1', 'A', 50, 100, 2_000, 2)],
    [cancel('o1', 'A', 70, 31_000, 1)],
  );
  assert.equal(result.lateJoins.length, 2);
  assert.deepEqual(result.lateJoins.map((j) => j.qty), [-50, -20]);
  assert.deepEqual(result.symbols, { A: { qty: 30, amountCents: 3_000 } });
});

test('proof commits to the input line numbers of both sides', () => {
  const result = joinStreams(
    [trade('o1', 'A', 100, 500, 1_000, 7)],
    [cancel('o1', 'A', 40, 2_000, 3), cancel('o1', 'A', 10, 3_000, 9)],
  );
  const { merkleRoot } = require('../lib/merkle');
  assert.equal(result.fills[0].proof, merkleRoot(['T7', 'C3', 'C9']));
});
