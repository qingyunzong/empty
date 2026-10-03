#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const rel = require('../src/relalg');
const { SettleError, settleIncremental, sortRows } = require('../src/engine');
const { makeCert, verifyCert } = require('../src/cert');
const { loadInputs } = require('../src/io');

function fail(err) {
  const code = err instanceof SettleError ? err.code : 'E_INTERNAL';
  const message = err instanceof Error ? err.message : String(err);
  fs.writeSync(process.stderr.fd, `${JSON.stringify({ code, message })}\n`);
  process.exit(1);
}

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        cert: { type: 'string' },
      },
    });
  } catch (err) {
    throw new SettleError('E_USAGE', err.message);
  }
}

// Semi-join trades against accounts (when accounts are provided) so every
// counterparty must be a known account.
function checkCounterparties(accounts, trades) {
  if (!accounts || accounts.length === 0) return;
  const acctRows = accounts
    .filter((a) => a && typeof a === 'object' && a.account_id !== undefined && a.account_id !== null)
    .map((a) => ({ counterparty: String(a.account_id) }));
  if (acctRows.length === 0) return;
  const known = new Set(rel.project(acctRows, ['counterparty']).map((r) => r.counterparty));
  for (const t of trades) {
    const cp = t && t.counterparty !== undefined && t.counterparty !== null ? String(t.counterparty) : null;
    if (cp !== null && !known.has(cp)) {
      throw new SettleError('E_UNKNOWN_ACCOUNT', `unknown counterparty "${cp}"`);
    }
  }
}

function cmdSettle(values) {
  const { in: inDir, out: outPath, cert: certPath } = values;
  if (!inDir || !outPath || !certPath) {
    throw new SettleError('E_USAGE', 'usage: settle --in <dir> --out <out.json> --cert <cert.json>');
  }
  const inputs = loadInputs(inDir);
  checkCounterparties(inputs.accounts, inputs.trades);
  const rows = sortRows(settleIncremental(inputs.trades, inputs.events));
  const cert = makeCert(rows, inputs.digests);
  const outDoc = { format: 'settle-out/1', row_count: rows.length, rows };
  fs.writeFileSync(outPath, `${JSON.stringify(outDoc, null, 2)}\n`);
  fs.writeFileSync(certPath, `${JSON.stringify(cert, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, row_count: rows.length, root: cert.root })}\n`);
}

function cmdVerify(values) {
  const { in: inDir, out: outPath, cert: certPath } = values;
  if (!outPath || !certPath) {
    throw new SettleError('E_USAGE', 'usage: settle verify --in <dir> --out <out.json> --cert <cert.json>');
  }
  let outDoc;
  let cert;
  try {
    outDoc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (err) {
    throw new SettleError('E_IO', `cannot read out file: ${err.message}`);
  }
  try {
    cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
  } catch (err) {
    throw new SettleError('E_IO', `cannot read cert file: ${err.message}`);
  }
  if (!outDoc || !Array.isArray(outDoc.rows)) {
    throw new SettleError('E_BAD_INPUT', 'out file has no rows array');
  }
  let digests = null;
  if (inDir) digests = loadInputs(inDir).digests;
  const result = verifyCert(outDoc.rows, cert, digests);
  if (!result.ok) {
    throw new SettleError('E_CERT_MISMATCH', `certificate verification failed: ${result.reason}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, row_count: cert.row_count, root: cert.root })}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] === 'verify' ? 'verify' : 'settle';
  const { values } = parseCli(command === 'verify' ? argv.slice(1) : argv);
  if (command === 'verify') cmdVerify(values);
  else cmdSettle(values);
}

try {
  main();
} catch (err) {
  fail(err);
}
