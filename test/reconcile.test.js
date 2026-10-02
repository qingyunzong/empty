import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEvent,
  certificate,
  createState,
  loadEvents,
  appendEvents,
  replay,
  stateHash,
} from '../src/reconcile.js';
import { runCli } from '../src/cli.js';

function suggest(state, bank, ledger, tolerance = 0) {
  applyEvent(state, { type: 'suggest', bank, ledger, tolerance });
}

test('exact one-to-many match succeeds and confirms', () => {
  const state = createState();
  suggest(
    state,
    [{ id: 'B1', amount: 100 }],
    [
      { id: 'L1', amount: 60 },
      { id: 'L2', amount: 40 },
      { id: 'L3', amount: 5 },
    ],
  );
  const suggested = state.candidates.filter((c) => c.status === 'suggested');
  assert.equal(suggested.length, 1);
  assert.deepEqual(suggested[0].ledgerIds, ['L1', 'L2']);
  assert.equal(suggested[0].branch, 'exact');

  applyEvent(state, { type: 'confirm', candidateId: suggested[0].id });
  const cert = certificate(state);
  assert.equal(cert.matches.length, 1);
  assert.deepEqual(cert.matches[0], {
    candidateId: suggested[0].id,
    bankId: 'B1',
    ledgerIds: ['L1', 'L2'],
    feeCents: 0,
  });
  assert.equal(cert.corrections.length, 0);
});

test('difference beyond tolerance is rejected', () => {
  const state = createState();
  suggest(state, [{ id: 'B1', amount: 100 }], [{ id: 'L1', amount: 90 }], 5);
  assert.equal(state.candidates.length, 0);
  assert.deepEqual(certificate(state), { matches: [], corrections: [] });

  // Within tolerance it becomes a fee candidate with a correction.
  const state2 = createState();
  suggest(state2, [{ id: 'B1', amount: 100 }], [{ id: 'L1', amount: 90 }], 10);
  const fee = state2.candidates.find((c) => c.branch === 'fee');
  assert.ok(fee);
  assert.equal(fee.fee, 1000);
  applyEvent(state2, { type: 'confirm', candidateId: fee.id });
  assert.deepEqual(certificate(state2).corrections, [
    { candidateId: fee.id, amountCents: 1000 },
  ]);
});

test('conflict between branches is deterministic and the loser entries stay reusable', () => {
  const state = createState();
  suggest(
    state,
    [
      { id: 'B1', amount: 100 },
      { id: 'B2', amount: 105 },
    ],
    [{ id: 'L1', amount: 100 }],
    10,
  );
  const exact = state.candidates.find((c) => c.branch === 'exact');
  const fee = state.candidates.find((c) => c.branch === 'fee');
  assert.ok(exact.id < fee.id);
  assert.equal(exact.status, 'suggested');
  assert.equal(fee.status, 'rejected');
  assert.throws(() => applyEvent(state, { type: 'confirm', candidateId: fee.id }), /rejected/);

  // B2 was not consumed by the rejected candidate: it can be matched later.
  suggest(state, [], [{ id: 'L2', amount: 105 }], 10);
  const reuse = state.candidates.find(
    (c) => c.bankId === 'B2' && c.ledgerIds.includes('L2'),
  );
  assert.ok(reuse);
  assert.equal(reuse.status, 'suggested');
});

test('undo after confirm restores unmatched state and rolls back the fee', () => {
  const state = createState();
  suggest(state, [{ id: 'B1', amount: 100 }], [{ id: 'L1', amount: 99 }], 2);
  const hashBefore = stateHash(state);
  const fee = state.candidates.find((c) => c.branch === 'fee');
  applyEvent(state, { type: 'confirm', candidateId: fee.id });
  assert.equal(certificate(state).matches.length, 1);
  assert.equal(certificate(state).corrections.length, 1);

  applyEvent(state, { type: 'undo', candidateId: fee.id });
  assert.deepEqual(certificate(state), { matches: [], corrections: [] });
  assert.equal(state.candidates.find((c) => c.id === fee.id).status, 'suggested');
  assert.equal(stateHash(state), hashBefore);
  assert.throws(() => applyEvent(state, { type: 'undo', candidateId: fee.id }), /not confirmed/);
});

// --- Independent enumerator cross-check -----------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent implementation: enumerate every equal-sum (bank, subset) combo
// for <=3 bank / <=3 ledger entries, number them by (bank order, bitmask
// order), then greedily pick the lowest-numbered feasible combo.
function independentExactSelection(bank, ledger) {
  const banks = bank
    .map((e) => ({ id: String(e.id), cents: Math.round(e.amount * 100) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const ledgers = ledger
    .map((e) => ({ id: String(e.id), cents: Math.round(e.amount * 100) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const combos = [];
  for (const b of banks) {
    for (let mask = 1; mask < 1 << ledgers.length; mask += 1) {
      let sum = 0;
      const ids = [];
      for (let i = 0; i < ledgers.length; i += 1) {
        if (mask & (1 << i)) {
          sum += ledgers[i].cents;
          ids.push(ledgers[i].id);
        }
      }
      if (sum === b.cents) combos.push({ bankId: b.id, ledgerIds: ids });
    }
  }
  const usedBank = new Set();
  const usedLedger = new Set();
  const picked = [];
  for (const combo of combos) {
    if (usedBank.has(combo.bankId)) continue;
    if (combo.ledgerIds.some((id) => usedLedger.has(id))) continue;
    usedBank.add(combo.bankId);
    for (const id of combo.ledgerIds) usedLedger.add(id);
    picked.push(combo);
  }
  return picked;
}

test('library selection matches independent enumerator on randomized small inputs', () => {
  const rand = mulberry32(20261003);
  const pool = [10, 20, 30, 40, 50, 60, 70, 100];
  for (let round = 0; round < 200; round += 1) {
    const bankCount = 1 + Math.floor(rand() * 3);
    const ledgerCount = 1 + Math.floor(rand() * 3);
    const bank = Array.from({ length: bankCount }, (_, i) => ({
      id: `B${i}`,
      amount: pool[Math.floor(rand() * pool.length)],
    }));
    const ledger = Array.from({ length: ledgerCount }, (_, i) => ({
      id: `L${i}`,
      amount: pool[Math.floor(rand() * pool.length)],
    }));

    const state = createState();
    suggest(state, bank, ledger, 0);
    const actual = state.candidates
      .filter((c) => c.status === 'suggested')
      .map((c) => ({ bankId: c.bankId, ledgerIds: c.ledgerIds }));
    const expected = independentExactSelection(bank, ledger);
    assert.deepEqual(
      actual,
      expected,
      `mismatch on round ${round}: ${JSON.stringify({ bank, ledger })}`,
    );

    // Candidate numbering is dense and matches enumeration order.
    state.candidates.forEach((c, i) => assert.equal(c.id, i + 1));
  }
});

test('persistence: replaying the event log reproduces the same certificate hash', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
  try {
    const events = [
      {
        type: 'suggest',
        bank: [
          { id: 'B1', amount: 100 },
          { id: 'B2', amount: 50 },
        ],
        ledger: [
          { id: 'L1', amount: 60 },
          { id: 'L2', amount: 40 },
          { id: 'L3', amount: 49.5 },
        ],
        tolerance: 1,
      },
      { type: 'confirm', candidateId: 1 },
      { type: 'confirm', candidateId: 2 },
      { type: 'undo', candidateId: 2 },
    ];
    const live = replay(events);
    appendEvents(workdir, events);
    const restored = replay(loadEvents(workdir));
    assert.equal(stateHash(restored), stateHash(live));
    assert.deepEqual(certificate(restored), certificate(live));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

// --- CLI -------------------------------------------------------------------

test('CLI outputs matches and state hash, and replay gives the same hash', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'reconcile-cli-'));
  try {
    const eventsFile = join(workdir, 'events.json');
    writeFileSync(
      eventsFile,
      JSON.stringify([
        {
          type: 'suggest',
          bank: [{ id: 'B1', amount: 100 }],
          ledger: [
            { id: 'L1', amount: 60 },
            { id: 'L2', amount: 40 },
          ],
          tolerance: 0,
        },
        { type: 'confirm', candidateId: 1 },
      ]),
    );
    const first = JSON.parse(runCli([eventsFile, workdir]).stdout);
    assert.equal(first.ok, true);
    assert.equal(first.matches.length, 1);
    assert.deepEqual(first.matches[0].ledgerIds, ['L1', 'L2']);
    assert.match(first.stateHash, /^[0-9a-f]{64}$/);

    // Second run with no new events replays the persisted log identically.
    writeFileSync(eventsFile, '[]');
    const second = JSON.parse(runCli([eventsFile, workdir]).stdout);
    assert.equal(second.stateHash, first.stateHash);
    assert.deepEqual(second.matches, first.matches);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('CLI exits 1 with a standard JSON error body on failure', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'reconcile-cli-'));
  try {
    const eventsFile = join(workdir, 'events.json');
    writeFileSync(eventsFile, JSON.stringify([{ type: 'confirm', candidateId: 99 }]));
    const result = runCli([eventsFile, workdir]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const body = JSON.parse(result.stderr);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /unknown candidate id/);

    const missing = runCli([]);
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stderr).ok, false);

    const badJson = join(workdir, 'bad.json');
    writeFileSync(badJson, 'not json');
    const unreadable = runCli([badJson, workdir]);
    assert.equal(unreadable.code, 1);
    assert.equal(JSON.parse(unreadable.stderr).ok, false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
