import { ReconError } from './csv.js';

export const KEY_COLS = ['date', 'account', 'txn_id'];

export function keyOf(row) {
  return `${row.date}${row.account}${row.txn_id}`;
}

// Build a hash index on the join key. Duplicate keys inside one source are
// ambiguous for a 1:1 reconciliation join -> E_AMBIGUOUS.
export function buildIndex(rows, sourceName) {
  const index = new Map();
  for (const row of rows) {
    const k = keyOf(row);
    if (index.has(k)) {
      throw new ReconError(
        'E_AMBIGUOUS',
        `${sourceName}: duplicate key (date=${row.date}, account=${row.account}, txn_id=${row.txn_id})`,
      );
    }
    index.set(k, row);
  }
  return index;
}

// SQL NULL semantics: NULL never equals anything, not even NULL.
export function sqlEq(a, b) {
  if (a === null || b === null) return null; // unknown
  return a === b;
}

function isNullFlag(a, b) {
  const aNull = a === null;
  const bNull = b === null;
  if (aNull && bNull) return 'both';
  if (aNull) return 'left';
  if (bNull) return 'right';
  return null;
}

// Planner: decide join strategy + order. Order never affects results, only cost.
export function planJoin(leftName, leftRows, rightName, rightRows, { useIndex }) {
  const steps = [];
  let buildName = rightName;
  let probeName = leftName;
  // Cost-based rule: hash join builds on the smaller relation to minimise
  // memory and probe work.
  if (rightRows.length > leftRows.length) {
    buildName = leftName;
    probeName = rightName;
  }
  if (useIndex) {
    steps.push(
      `HASH JOIN ${leftName} x ${rightName}: build hash index on ${buildName} ` +
      `(${Math.min(leftRows.length, rightRows.length)} rows), probe with ${probeName} ` +
      `(${Math.max(leftRows.length, rightRows.length)} rows)`,
    );
  } else {
    steps.push(
      `NESTED LOOP JOIN ${leftName} x ${rightName}: index disabled, ` +
      `${leftRows.length}x${rightRows.length} comparisons`,
    );
  }
  steps.push('join order chosen by cost only; results are order-invariant (commutative join + sorted output)');
  return { steps, buildName };
}

function lookupFactory(rows, useIndex, sourceName, indexes) {
  if (!useIndex) return null;
  if (!indexes.has(sourceName)) indexes.set(sourceName, buildIndex(rows, sourceName));
  return indexes.get(sourceName);
}

// Difference (anti-join): rows in `left` whose key is absent from `right`.
export function difference(left, right, { useIndex, rightName, indexes }) {
  const idx = lookupFactory(right, useIndex, rightName, indexes);
  const out = [];
  for (const row of left) {
    const k = keyOf(row);
    const found = idx ? idx.has(k) : right.some((r) => keyOf(r) === k);
    if (!found) out.push(row);
  }
  return out;
}

// Inner equi-join on the key, returning [leftRow, rightRow] pairs.
export function innerJoin(left, right, { useIndex, rightName, indexes }) {
  const idx = lookupFactory(right, useIndex, rightName, indexes);
  const pairs = [];
  for (const l of left) {
    const k = keyOf(l);
    let r;
    if (idx) r = idx.get(k);
    else r = right.find((x) => keyOf(x) === k);
    if (r) pairs.push([l, r]);
  }
  return pairs;
}

const sortByKey = (a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

function project(row, cols) {
  const o = {};
  for (const c of cols) o[c] = row[c];
  return o;
}

export function reconcile({ internal, bank, fee }, { useIndex = true } = {}) {
  const plan = [];
  const indexes = new Map();

  // Validate key uniqueness up-front; duplicate keys make the join ambiguous.
  buildIndex(internal, 'internal.csv');
  buildIndex(bank, 'bank.csv');
  buildIndex(fee, 'fee.csv');

  plan.push(...planJoin('internal', internal, 'bank', bank, { useIndex }).steps);
  const joined = innerJoin(internal, bank, { useIndex, rightName: 'bank.csv', indexes });
  const onlyInternal = difference(internal, bank, { useIndex, rightName: 'bank.csv', indexes });
  const onlyBank = difference(bank, internal, { useIndex, rightName: 'internal.csv', indexes });

  const matched = [];
  const amountDiff = [];
  for (const [i, b] of joined) {
    const eq = sqlEq(i.amount, b.amount);
    if (eq === true) {
      matched.push({ ...project(i, KEY_COLS), currency: i.currency, amount: i.amount });
    } else {
      amountDiff.push({
        ...project(i, KEY_COLS),
        currency: i.currency,
        internalAmount: i.amount,
        bankAmount: b.amount,
        isNull: isNullFlag(i.amount, b.amount),
      });
    }
  }

  plan.push(...planJoin('internal', internal, 'fee', fee, { useIndex }).steps);
  const feeJoined = innerJoin(internal, fee, { useIndex, rightName: 'fee.csv', indexes });
  const feeDiff = [];
  for (const [i, f] of feeJoined) {
    const eq = sqlEq(i.fee, f.fee);
    if (eq !== true) {
      feeDiff.push({
        ...project(i, KEY_COLS),
        currency: i.currency,
        internalFee: i.fee,
        expectedFee: f.fee,
        isNull: isNullFlag(i.fee, f.fee),
      });
    }
  }

  // Aggregation: summarise differences per currency; avg ignores NULLs.
  const summaryByCurrency = {};
  const bump = (currency, leftVal, rightVal) => {
    const s = (summaryByCurrency[currency] ??= { currency, diffCount: 0, sumAbsDiff: 0, avgAbsDiff: null, _n: 0 });
    s.diffCount += 1;
    if (leftVal !== null && rightVal !== null) {
      s.sumAbsDiff += Math.abs(leftVal - rightVal);
      s._n += 1;
    }
  };
  for (const d of amountDiff) bump(d.currency, d.internalAmount, d.bankAmount);
  for (const d of feeDiff) bump(d.currency, d.internalFee, d.expectedFee);
  for (const s of Object.values(summaryByCurrency)) {
    s.avgAbsDiff = s._n === 0 ? null : s.sumAbsDiff / s._n;
    delete s._n;
  }

  const sortRecs = (arr) => arr.sort((a, b) => sortByKey(a, b));
  const result = {
    matched: sortRecs(matched),
    onlyInternal: sortRecs(onlyInternal.map((r) => project(r, [...KEY_COLS, 'currency', 'amount', 'fee']))),
    onlyBank: sortRecs(onlyBank.map((r) => project(r, [...KEY_COLS, 'currency', 'amount']))),
    amountDiff: sortRecs(amountDiff),
    feeDiff: sortRecs(feeDiff),
    summaryByCurrency: Object.values(summaryByCurrency).sort((a, b) => (a.currency < b.currency ? -1 : 1)),
  };
  return { result, plan: plan.join('\n') + '\n' };
}
