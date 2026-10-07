'use strict';

const { toCents } = require('./ledger');

// Compare ledger expectations against the acquirer/settlement statement.
// settlement: [{ txnId, amount, localDay }] (amount in major units).
function reconcile(ledger, settlement) {
  const diffs = [];
  const rateHits = [];
  const lineByTxn = new Map();
  for (const line of settlement) {
    lineByTxn.set(line.txnId, line);
  }
  const seen = new Set();
  let matched = 0;

  for (const p of ledger.postings) {
    rateHits.push({ txnId: p.txnId, pair: p.pair, hit: p.rateHit });
    if (!p.rateHit) {
      diffs.push({ type: 'NO_RATE', txnId: p.txnId, pair: p.pair, utc: p.utc });
      continue;
    }
    const line = lineByTxn.get(p.txnId);
    if (!line) {
      diffs.push({ type: 'MISSING_IN_SETTLEMENT', txnId: p.txnId, expected: p.expected });
      continue;
    }
    seen.add(p.txnId);
    const actualCents = toCents(line.amount);
    let ok = true;
    if (actualCents !== p.expected.amountCents) {
      diffs.push({
        type: 'AMOUNT_MISMATCH',
        txnId: p.txnId,
        expectedCents: p.expected.amountCents,
        actualCents,
      });
      ok = false;
    }
    if (line.localDay !== undefined && line.localDay !== p.expected.localDay) {
      diffs.push({
        type: 'DAY_MISMATCH',
        txnId: p.txnId,
        expectedDay: p.expected.localDay,
        actualDay: line.localDay,
      });
      ok = false;
    }
    if (ok) matched += 1;
  }

  for (const line of settlement) {
    if (!seen.has(line.txnId) && !ledger.postings.some((p) => p.txnId === line.txnId)) {
      diffs.push({ type: 'UNEXPECTED_IN_SETTLEMENT', txnId: line.txnId, line });
    }
  }

  return {
    diffs,
    rateHits,
    attestations: ledger.postings.map((p) => ({ txnId: p.txnId, ...p.attestation })),
    summary: {
      postings: ledger.postings.length,
      settlementLines: settlement.length,
      matched,
      diffs: diffs.length,
    },
  };
}

module.exports = { reconcile };
