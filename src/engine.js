'use strict';
const { ReconError } = require('./csv');

// Expected fee rate: 10 bps (0.1%) of the internal amount, rounded to cents.
const FEE_RATE_BPS = 10;

const KEY_SEP = '\u0001';
function keyOf(r) {
  return r.settleDate + KEY_SEP + r.account + KEY_SEP + r.serialNo;
}

function centsToNum(cents) {
  return cents === null ? null : cents / 100;
}

function expectedFeeCents(amountCents) {
  if (amountCents === null) return null;
  return Math.round((amountCents * FEE_RATE_BPS) / 10000);
}

function checkDuplicates(rows, file) {
  const seen = new Set();
  for (const r of rows) {
    const k = keyOf(r);
    if (seen.has(k)) {
      throw new ReconError(
        'E_AMBIGUOUS',
        `${file}: duplicate key (settle_date=${r.settleDate}, account=${r.account}, serial_no=${r.serialNo})`
      );
    }
    seen.add(k);
  }
}

const cmpKey = (a, b) => {
  if (a.settleDate !== b.settleDate) return a.settleDate < b.settleDate ? -1 : 1;
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  if (a.serialNo !== b.serialNo) return a.serialNo < b.serialNo ? -1 : 1;
  return 0;
};

function rowOut(r, amountField) {
  return {
    settleDate: r.settleDate,
    account: r.account,
    serialNo: r.serialNo,
    [amountField]: centsToNum(r.amountCents),
    currency: r.currency,
  };
}

// Relational core.
//   matched      = (internal ⋈ bank) filtered by SQL equality on amount
//                  (NULL <> everything, including NULL)
//   onlyInternal = internal − bank   (set difference on keys)
//   onlyBank     = bank − internal   (set difference on keys)
//   feeDiff      = amount mismatches on the key intersection (kind="amount",
//                  isNull when either side is NULL) plus fee mismatches
//                  against fee.csv (kind="fee").
function reconcile({ internal, bank, fee, useIndex }) {
  checkDuplicates(internal, 'internal.csv');
  checkDuplicates(bank, 'bank.csv');
  checkDuplicates(fee, 'fee.csv');

  const plan = [];
  plan.push('Reconciliation Plan');
  plan.push('===================');
  plan.push(`Relations: internal=${internal.length} rows, bank=${bank.length} rows, fee=${fee.length} rows`);
  plan.push('Join keys: (settle_date, account, serial_no)');

  // Join order: build on the smaller relation, probe with the larger one.
  const buildIsInternal = internal.length <= bank.length;
  const buildRows = buildIsInternal ? internal : bank;
  const probeRows = buildIsInternal ? bank : internal;
  const buildName = buildIsInternal ? 'internal' : 'bank';
  const probeName = buildIsInternal ? 'bank' : 'internal';

  const pairs = []; // key-intersection pairs {internal, bank}
  let probeOnly;
  let buildOnly;

  if (useIndex) {
    plan.push(`Strategy: hash-join (index ON)`);
    plan.push(
      `Join order: build hash index on ${buildName} (${buildRows.length} rows, smaller relation) ` +
        `then probe with ${probeName} (${probeRows.length} rows).`
    );
    plan.push(
      'Rationale: building on the smaller relation minimizes hash-table memory and build cost; ' +
        'probing the larger relation is O(1) per row, total O(N+M).'
    );
    const index = new Map();
    for (const r of buildRows) index.set(keyOf(r), r);
    const matchedBuildKeys = new Set();
    probeOnly = [];
    for (const p of probeRows) {
      const hit = index.get(keyOf(p));
      if (hit) {
        pairs.push(buildIsInternal ? { internal: hit, bank: p } : { internal: p, bank: hit });
        matchedBuildKeys.add(keyOf(p));
      } else {
        probeOnly.push(p);
      }
    }
    buildOnly = buildRows.filter((r) => !matchedBuildKeys.has(keyOf(r)));
  } else {
    plan.push('Strategy: nested-loop join (index OFF)');
    plan.push(
      `Join order: scan ${probeName} (${probeRows.length} rows) as outer loop over ` +
        `${buildName} (${buildRows.length} rows) as inner loop.`
    );
    plan.push(
      'Rationale: no hash index available; quadratic O(N*M) key comparison. ' +
        'Outer loop is the larger relation so the inner scan short-circuits on first match.'
    );
    const matchedBuildKeys = new Set();
    probeOnly = [];
    for (const p of probeRows) {
      let hit = null;
      for (const b of buildRows) {
        if (keyOf(b) === keyOf(p)) { hit = b; break; }
      }
      if (hit) {
        pairs.push(buildIsInternal ? { internal: hit, bank: p } : { internal: p, bank: hit });
        matchedBuildKeys.add(keyOf(hit));
      } else {
        probeOnly.push(p);
      }
    }
    buildOnly = buildRows.filter((r) => !matchedBuildKeys.has(keyOf(r)));
  }

  const onlyInternal = buildIsInternal ? buildOnly : probeOnly;
  const onlyBank = buildIsInternal ? probeOnly : buildOnly;

  plan.push('Anti-joins: onlyInternal = internal - bank, onlyBank = bank - internal (key-set difference).');
  plan.push('NULL semantics: amount NULL never equals anything (SQL three-valued logic);');
  plan.push('  NULL-involving mismatches are flagged isNull and reported as diffs, never as matches.');
  plan.push('Aggregation: GROUP BY currency over diffs; SUM/AVG computed on non-NULL diffs only (AVG ignores NULL).');
  plan.push('Determinism: all outputs sorted by (settle_date, account, serial_no);');
  plan.push('  results are independent of input order, join order, and index strategy.');

  const matched = [];
  const feeDiff = [];

  for (const { internal: a, bank: b } of pairs) {
    const bothNonNull = a.amountCents !== null && b.amountCents !== null;
    const sameCurrency = a.currency === b.currency;
    if (bothNonNull && sameCurrency && a.amountCents === b.amountCents) {
      matched.push({
        settleDate: a.settleDate,
        account: a.account,
        serialNo: a.serialNo,
        amount: centsToNum(a.amountCents),
        currency: a.currency,
      });
    } else {
      feeDiff.push({
        kind: 'amount',
        settleDate: a.settleDate,
        account: a.account,
        serialNo: a.serialNo,
        currency: a.currency,
        internalAmount: centsToNum(a.amountCents),
        bankAmount: centsToNum(b.amountCents),
        isNull: a.amountCents === null || b.amountCents === null,
        diff: bothNonNull && sameCurrency ? centsToNum(b.amountCents - a.amountCents) : null,
      });
    }
  }

  const feeMap = new Map();
  for (const f of fee) feeMap.set(keyOf(f), f);
  for (const { internal: a } of pairs) {
    const f = feeMap.get(keyOf(a));
    if (!f) continue;
    const expected = expectedFeeCents(a.amountCents);
    const actual = f.feeCents;
    if (expected === null || actual === null) {
      // NULL never equals NULL: any NULL involvement is a diff.
      feeDiff.push({
        kind: 'fee',
        settleDate: a.settleDate,
        account: a.account,
        serialNo: a.serialNo,
        currency: a.currency,
        expectedFee: centsToNum(expected),
        actualFee: centsToNum(actual),
        isNull: true,
        diff: null,
      });
    } else if (expected !== actual) {
      feeDiff.push({
        kind: 'fee',
        settleDate: a.settleDate,
        account: a.account,
        serialNo: a.serialNo,
        currency: a.currency,
        expectedFee: centsToNum(expected),
        actualFee: centsToNum(actual),
        isNull: false,
        diff: centsToNum(actual - expected),
      });
    }
  }

  matched.sort(cmpKey);
  onlyInternal.sort(cmpKey);
  onlyBank.sort(cmpKey);
  feeDiff.sort((x, y) => cmpKey(x, y) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));

  const byCurrency = {};
  const bucketFor = (currency, kind) => {
    if (!byCurrency[currency]) {
      byCurrency[currency] = {
        amountDiff: { entries: 0, nonNull: 0, sum: 0, avg: null },
        feeDiff: { entries: 0, nonNull: 0, sum: 0, avg: null },
      };
    }
    return kind === 'amount' ? byCurrency[currency].amountDiff : byCurrency[currency].feeDiff;
  };
  for (const d of feeDiff) {
    const bucket = bucketFor(d.currency, d.kind);
    bucket.entries += 1;
    if (d.diff !== null) {
      bucket.nonNull += 1;
      bucket.sum += Math.round(d.diff * 100);
    }
  }
  for (const currency of Object.keys(byCurrency)) {
    for (const kind of ['amountDiff', 'feeDiff']) {
      const bucket = byCurrency[currency][kind];
      if (bucket.nonNull > 0) bucket.avg = Math.round(bucket.sum / bucket.nonNull) / 100;
      bucket.sum = bucket.sum / 100;
    }
  }

  const result = {
    matched,
    onlyInternal: onlyInternal.map((r) => rowOut(r, 'amount')),
    onlyBank: onlyBank.map((r) => rowOut(r, 'amount')),
    feeDiff,
    summary: { feeRateBps: FEE_RATE_BPS, byCurrency },
  };
  return { result, plan: plan.join('\n') + '\n' };
}

module.exports = { reconcile, ReconError, keyOf, expectedFeeCents, FEE_RATE_BPS };
