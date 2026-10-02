#!/usr/bin/env node
'use strict';
// Independent brute-force reference implementation for cross-checking recon.
// Naive nested loops, no index, no shared code with src/.
// Usage: node scripts/brute.js --dir <dir>   (prints result JSON to stdout)
const fs = require('node:fs');
const path = require('node:path');

const FEE_RATE_BPS = 10;

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const f = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = f[i]; });
    return row;
  });
}

function cents(raw) {
  if (raw === '' || raw.toUpperCase() === 'NULL') return null;
  const neg = raw.startsWith('-');
  const body = neg ? raw.slice(1) : raw;
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? '' : body.slice(dot + 1);
  const v = Number(intPart) * 100 + Number((fracPart + '00').slice(0, 2));
  return neg ? -v : v;
}

const num = (c) => (c === null ? null : c / 100);
const keyOf = (r) => r.settle_date + '\u0001' + r.account + '\u0001' + r.serial_no;

function main() {
  const dirIdx = process.argv.indexOf('--dir');
  if (dirIdx === -1 || !process.argv[dirIdx + 1]) {
    process.stderr.write('usage: node scripts/brute.js --dir <dir>\n');
    process.exit(2);
  }
  const dir = process.argv[dirIdx + 1];
  const internal = readCsv(path.join(dir, 'internal.csv')).map((r) => ({ ...r, amountCents: cents(r.amount) }));
  const bank = readCsv(path.join(dir, 'bank.csv')).map((r) => ({ ...r, amountCents: cents(r.amount) }));
  const fee = readCsv(path.join(dir, 'fee.csv')).map((r) => ({ ...r, feeCents: cents(r.fee) }));

  // Naive key-intersection: for each internal row, linear scan bank.
  const pairs = [];
  const onlyInternal = [];
  for (const a of internal) {
    const hit = bank.find((b) => keyOf(b) === keyOf(a));
    if (hit) pairs.push([a, hit]);
    else onlyInternal.push(a);
  }
  const onlyBank = bank.filter((b) => !internal.some((a) => keyOf(a) === keyOf(b)));

  const matched = [];
  const feeDiff = [];
  for (const [a, b] of pairs) {
    const bothNonNull = a.amountCents !== null && b.amountCents !== null;
    const sameCcy = a.currency === b.currency;
    if (bothNonNull && sameCcy && a.amountCents === b.amountCents) {
      matched.push({
        settleDate: a.settle_date, account: a.account, serialNo: a.serial_no,
        amount: num(a.amountCents), currency: a.currency,
      });
    } else {
      feeDiff.push({
        kind: 'amount',
        settleDate: a.settle_date, account: a.account, serialNo: a.serial_no,
        currency: a.currency,
        internalAmount: num(a.amountCents), bankAmount: num(b.amountCents),
        isNull: a.amountCents === null || b.amountCents === null,
        diff: bothNonNull && sameCcy ? num(b.amountCents - a.amountCents) : null,
      });
    }
  }
  for (const [a] of pairs) {
    const f = fee.find((x) => keyOf(x) === keyOf(a));
    if (!f) continue;
    const expected = a.amountCents === null ? null : Math.round((a.amountCents * FEE_RATE_BPS) / 10000);
    const actual = f.feeCents;
    if (expected === null || actual === null) {
      feeDiff.push({
        kind: 'fee',
        settleDate: a.settle_date, account: a.account, serialNo: a.serial_no,
        currency: a.currency,
        expectedFee: num(expected), actualFee: num(actual),
        isNull: true, diff: null,
      });
    } else if (expected !== actual) {
      feeDiff.push({
        kind: 'fee',
        settleDate: a.settle_date, account: a.account, serialNo: a.serial_no,
        currency: a.currency,
        expectedFee: num(expected), actualFee: num(actual),
        isNull: false, diff: num(actual - expected),
      });
    }
  }

  const cmp = (x, y) =>
    (x.settleDate < y.settleDate ? -1 : x.settleDate > y.settleDate ? 1 : 0) ||
    (x.account < y.account ? -1 : x.account > y.account ? 1 : 0) ||
    (x.serialNo < y.serialNo ? -1 : x.serialNo > y.serialNo ? 1 : 0);
  matched.sort(cmp);
  onlyInternal.sort((a, b) => cmp({ settleDate: a.settle_date, account: a.account, serialNo: a.serial_no },
                                  { settleDate: b.settle_date, account: b.account, serialNo: b.serial_no }));
  onlyBank.sort((a, b) => cmp({ settleDate: a.settle_date, account: a.account, serialNo: a.serial_no },
                              { settleDate: b.settle_date, account: b.account, serialNo: b.serial_no }));
  feeDiff.sort((x, y) => cmp(x, y) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));

  const byCurrency = {};
  for (const d of feeDiff) {
    if (!byCurrency[d.currency]) {
      byCurrency[d.currency] = {
        amountDiff: { entries: 0, nonNull: 0, sum: 0, avg: null },
        feeDiff: { entries: 0, nonNull: 0, sum: 0, avg: null },
      };
    }
    const bucket = d.kind === 'amount' ? byCurrency[d.currency].amountDiff : byCurrency[d.currency].feeDiff;
    bucket.entries += 1;
    if (d.diff !== null) { bucket.nonNull += 1; bucket.sum += Math.round(d.diff * 100); }
  }
  for (const ccy of Object.keys(byCurrency)) {
    for (const kind of ['amountDiff', 'feeDiff']) {
      const bucket = byCurrency[ccy][kind];
      if (bucket.nonNull > 0) bucket.avg = Math.round(bucket.sum / bucket.nonNull) / 100;
      bucket.sum = bucket.sum / 100;
    }
  }

  const outRow = (r) => ({
    settleDate: r.settle_date, account: r.account, serialNo: r.serial_no,
    amount: num(r.amountCents), currency: r.currency,
  });
  process.stdout.write(JSON.stringify({
    matched,
    onlyInternal: onlyInternal.map(outRow),
    onlyBank: onlyBank.map(outRow),
    feeDiff,
    summary: { feeRateBps: FEE_RATE_BPS, byCurrency },
  }, null, 2) + '\n');
}

main();
