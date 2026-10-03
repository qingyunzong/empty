'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReconEngine, ReconError, replay } = require('../src/recon');

function initEvent(tolerance, bankEntries, ledgerEntries) {
  return { type: 'init', tolerance, bankEntries, ledgerEntries };
}

test('exact one-to-many match succeeds', () => {
  const engine = new ReconEngine();
  engine.applyEvent(initEvent(
    0,
    [{ id: 'B1', amount: 100 }],
    [{ id: 'L1', amount: 60 }, { id: 'L2', amount: 40 }, { id: 'L3', amount: 7 }],
  ));
  const suggested = engine.applyEvent({ type: 'suggest' });
  assert.equal(suggested.candidates.length, 1);
  assert.deepEqual(suggested.candidates[0], {
    number: 1,
    branch: 'exact',
    bankId: 'B1',
    ledgerIds: ['L1', 'L2'],
    fee: 0,
    status: 'suggested',
  });
  const confirmed = engine.applyEvent({ type: 'confirm', candidate: 1 });
  assert.equal(confirmed.match, 'M1');
  const cert = engine.certificate();
  assert.deepEqual(cert.matches, [{ id: 'M1', candidate: 1, bankId: 'B1', ledgerIds: ['L1', 'L2'], fee: 0 }]);
  assert.deepEqual(cert.unmatchedBank, []);
  assert.deepEqual(cert.unmatchedLedger, ['L3']);
  assert.deepEqual(cert.totals, { matchedBankAmount: 100, matchedLedgerAmount: 100, feeTotal: 0 });
});

test('difference beyond tolerance is rejected, within tolerance books a fee correction', () => {
  const engine = new ReconEngine();
  engine.applyEvent(initEvent(3, [{ id: 'B1', amount: 100 }], [{ id: 'L1', amount: 95 }]));
  const suggested = engine.applyEvent({ type: 'suggest' });
  assert.deepEqual(suggested.candidates, []);
  assert.throws(
    () => engine.applyEvent({ type: 'confirm', candidate: 1 }),
    (err) => err instanceof ReconError && err.code === 'CANDIDATE_NOT_FOUND',
  );
  assert.deepEqual(engine.certificate().unmatchedBank, ['B1']);
  assert.deepEqual(engine.certificate().unmatchedLedger, ['L1']);

  const engine2 = new ReconEngine();
  engine2.applyEvent(initEvent(3, [{ id: 'B1', amount: 100 }], [{ id: 'L1', amount: 97 }]));
  const suggested2 = engine2.applyEvent({ type: 'suggest' });
  assert.equal(suggested2.candidates.length, 1);
  assert.equal(suggested2.candidates[0].branch, 'fee');
  assert.equal(suggested2.candidates[0].fee, 3);
  engine2.applyEvent({ type: 'confirm', candidate: 1 });
  const cert = engine2.certificate();
  assert.deepEqual(cert.feeCorrections, [{ matchId: 'M1', amount: 3 }]);
  assert.equal(cert.totals.feeTotal, 3);
});

test('conflicting branches resolve deterministically and the loser stays reusable', () => {
  const engine = new ReconEngine();
  engine.applyEvent(initEvent(
    10,
    [{ id: 'B1', amount: 100 }, { id: 'B2', amount: 105 }],
    [{ id: 'L1', amount: 100 }, { id: 'L2', amount: 105 }],
  ));
  const suggested = engine.applyEvent({ type: 'suggest' });
  const byNumber = new Map(suggested.candidates.map((c) => [c.number, c]));
  assert.equal(suggested.candidates.length, 4);
  assert.deepEqual(
    { ...byNumber.get(1), ledgerIds: undefined },
    { number: 1, branch: 'exact', bankId: 'B1', ledgerIds: undefined, fee: 0, status: 'suggested' },
  );
  assert.deepEqual(byNumber.get(1).ledgerIds, ['L1']);
  assert.equal(byNumber.get(2).status, 'rejected');
  assert.equal(byNumber.get(2).reason, 'conflict');
  assert.equal(byNumber.get(3).status, 'suggested');
  assert.equal(byNumber.get(3).branch, 'exact');
  assert.equal(byNumber.get(3).bankId, 'B2');
  assert.equal(byNumber.get(4).status, 'rejected');
  assert.equal(byNumber.get(4).reason, 'conflict');
  assert.equal(byNumber.get(4).branch, 'fee');
  assert.deepEqual(byNumber.get(4).ledgerIds, ['L1']);

  assert.throws(
    () => engine.applyEvent({ type: 'confirm', candidate: 4 }),
    (err) => err instanceof ReconError && err.code === 'CANDIDATE_NOT_CONFIRMABLE',
  );
  const reused = engine.applyEvent({ type: 'confirm', candidate: 3 });
  assert.equal(reused.match, 'M1');
  engine.applyEvent({ type: 'confirm', candidate: 1 });
  const cert = engine.certificate();
  assert.deepEqual(cert.unmatchedBank, []);
  assert.deepEqual(cert.unmatchedLedger, []);
  assert.equal(cert.matches.length, 2);
});

test('undo after confirm releases entries and rolls back the fee', () => {
  const engine = new ReconEngine();
  engine.applyEvent(initEvent(5, [{ id: 'B1', amount: 103 }], [{ id: 'L1', amount: 100 }]));
  engine.applyEvent({ type: 'suggest' });
  const hashBeforeConfirm = engine.stateHash();
  engine.applyEvent({ type: 'confirm', candidate: 1 });
  const certConfirmed = engine.certificate();
  assert.deepEqual(certConfirmed.feeCorrections, [{ matchId: 'M1', amount: 3 }]);
  assert.deepEqual(certConfirmed.unmatchedBank, []);
  assert.deepEqual(certConfirmed.unmatchedLedger, []);

  const undone = engine.applyEvent({ type: 'undo', match: 'M1' });
  assert.deepEqual(undone.released, { bank: ['B1'], ledger: ['L1'] });
  assert.equal(undone.feeRolledBack, 3);
  const certAfterUndo = engine.certificate();
  assert.deepEqual(certAfterUndo.matches, []);
  assert.deepEqual(certAfterUndo.feeCorrections, []);
  assert.deepEqual(certAfterUndo.unmatchedBank, ['B1']);
  assert.deepEqual(certAfterUndo.unmatchedLedger, ['L1']);
  assert.equal(engine.stateHash(), hashBeforeConfirm);
  assert.throws(
    () => engine.applyEvent({ type: 'undo', match: 'M1' }),
    (err) => err instanceof ReconError && err.code === 'MATCH_NOT_ACTIVE',
  );
});

test('replaying the same event log reproduces the identical certificate', () => {
  const events = [
    initEvent(
      10,
      [{ id: 'B1', amount: 100 }, { id: 'B2', amount: 105 }],
      [{ id: 'L1', amount: 100 }, { id: 'L2', amount: 105 }],
    ),
    { type: 'suggest' },
    { type: 'confirm', candidate: 1 },
    { type: 'confirm', candidate: 3 },
    { type: 'undo', match: 'M1' },
    { type: 'suggest' },
    { type: 'confirm', candidate: 5 },
  ];
  const engine = new ReconEngine();
  const results = events.map((e) => engine.applyEvent(e));
  const replayed = replay(events, results);
  assert.equal(replayed.stateHash(), engine.stateHash());
  assert.deepEqual(replayed.certificate(), engine.certificate());
  assert.throws(
    () => replay(events, results.map((r, i) => (i === 2 ? { ...r, match: 'M9' } : r))),
    (err) => err instanceof ReconError && err.code === 'LOG_MISMATCH',
  );
});

function* oracleCombinations(n, k) {
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
}

function oracleSuggest(bankEntries, ledgerEntries, tolerance) {
  const usedBank = new Set();
  const usedLedger = new Set();
  const candidates = [];
  let number = 1;
  for (const bankEntry of bankEntries) {
    for (const branch of ['exact', 'fee']) {
      for (let size = 1; size <= ledgerEntries.length; size += 1) {
        for (const idxs of oracleCombinations(ledgerEntries.length, size)) {
          const ids = idxs.map((i) => ledgerEntries[i].id);
          const sum = idxs.reduce((acc, i) => acc + ledgerEntries[i].amount, 0);
          const diff = bankEntry.amount - sum;
          const feasible = branch === 'exact' ? diff === 0 : diff !== 0 && Math.abs(diff) <= tolerance;
          if (!feasible) continue;
          const candidate = {
            number,
            branch,
            bankId: bankEntry.id,
            ledgerIds: ids,
            fee: branch === 'fee' ? diff : 0,
            status: 'suggested',
          };
          number += 1;
          if (usedBank.has(bankEntry.id) || ids.some((id) => usedLedger.has(id))) {
            candidate.status = 'rejected';
            candidate.reason = 'conflict';
          } else {
            usedBank.add(bankEntry.id);
            for (const id of ids) usedLedger.add(id);
          }
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

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

test('engine suggestions match an independent enumerator oracle (<=3 bank, <=3 ledger)', () => {
  const rand = mulberry32(20261004);
  for (let caseNo = 0; caseNo < 300; caseNo += 1) {
    const bankCount = 1 + Math.floor(rand() * 3);
    const ledgerCount = 1 + Math.floor(rand() * 3);
    const ledgerEntries = Array.from({ length: ledgerCount }, (_, i) => ({
      id: `L${i + 1}`,
      amount: 1 + Math.floor(rand() * 60),
    }));
    const bankEntries = Array.from({ length: bankCount }, (_, i) => {
      if (rand() < 0.6) {
        const subset = ledgerEntries.filter(() => rand() < 0.5);
        const base = subset.reduce((acc, e) => acc + e.amount, 0);
        const delta = Math.floor(rand() * 7) - 3;
        return { id: `B${i + 1}`, amount: Math.max(1, base + delta) };
      }
      return { id: `B${i + 1}`, amount: 1 + Math.floor(rand() * 150) };
    });
    const tolerance = Math.floor(rand() * 6);
    const engine = new ReconEngine();
    engine.applyEvent(initEvent(tolerance, bankEntries, ledgerEntries));
    const suggested = engine.applyEvent({ type: 'suggest' });
    const expected = oracleSuggest(bankEntries, ledgerEntries, tolerance);
    assert.deepEqual(suggested.candidates, expected, `case ${caseNo}: ${JSON.stringify({ bankEntries, ledgerEntries, tolerance })}`);
  }
});
