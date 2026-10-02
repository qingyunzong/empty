'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv, ReconError } = require('./csv');
const { reconcile } = require('./engine');

const LEDGER_HEADER = ['settle_date', 'account', 'serial_no', 'amount', 'currency'];
const FEE_HEADER = ['settle_date', 'account', 'serial_no', 'fee', 'currency'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^-?\d{1,15}(\.\d{1,2})?$/;

function parseAmountCents(raw, file, line, column) {
  if (raw === '' || raw.toUpperCase() === 'NULL') return null;
  if (!AMOUNT_RE.test(raw)) {
    throw new ReconError('E_SCHEMA', `${file}:${line}: invalid ${column} value "${raw}" (expected decimal with up to 2 fraction digits, or NULL)`);
  }
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const [intPart, fracPart = ''] = body.split('.');
  const cents = Number(intPart) * 100 + Number((fracPart + '00').slice(0, 2));
  return negative ? -cents : cents;
}

function validateHeader(header, expected, file) {
  if (header.length !== expected.length || !expected.every((c, i) => header[i] === c)) {
    throw new ReconError(
      'E_SCHEMA',
      `${file}: bad header [${header.join(',')}], expected [${expected.join(',')}]`
    );
  }
}

function loadRelation(dir, name, header, amountColumn) {
  const file = path.join(dir, name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ReconError('E_SCHEMA', `${name}: cannot read file (${file})`);
  }
  const rows = parseCsv(text, name);
  if (rows.length === 0) throw new ReconError('E_SCHEMA', `${name}: missing header row`);
  validateHeader(rows[0], header, name);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const fields = rows[i];
    const line = i + 1;
    if (fields.length !== header.length) {
      throw new ReconError('E_SCHEMA', `${name}:${line}: expected ${header.length} fields, got ${fields.length}`);
    }
    const [settleDate, account, serialNo, amountRaw, currency] = fields;
    if (!DATE_RE.test(settleDate)) {
      throw new ReconError('E_SCHEMA', `${name}:${line}: invalid settle_date "${settleDate}" (expected YYYY-MM-DD)`);
    }
    if (account === '' || serialNo === '') {
      throw new ReconError('E_SCHEMA', `${name}:${line}: account and serial_no must be non-empty`);
    }
    if (currency === '') {
      throw new ReconError('E_SCHEMA', `${name}:${line}: currency must be non-empty`);
    }
    out.push({
      settleDate,
      account,
      serialNo,
      amountCents: parseAmountCents(amountRaw, name, line, amountColumn),
      currency,
    });
  }
  return out;
}

function toFeeRows(rows) {
  return rows.map((r) => ({
    settleDate: r.settleDate,
    account: r.account,
    serialNo: r.serialNo,
    feeCents: r.amountCents,
    currency: r.currency,
  }));
}

function parseArgs(argv) {
  const opts = { dir: null, out: null, explain: null, useIndex: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--explain') opts.explain = argv[++i];
    else if (arg === '--no-index') opts.useIndex = false;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new ReconError('E_USAGE', `unknown argument: ${arg}`);
  }
  for (const k of ['dir', 'out', 'explain']) {
    if (!opts[k]) throw new ReconError('E_USAGE', `missing required argument --${k}`);
  }
  return opts;
}

const USAGE = 'Usage: recon --dir <dir> --out <result.json> --explain <plan.txt> [--no-index]';

function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(USAGE + '\n');
      return 0;
    }
    const internal = loadRelation(opts.dir, 'internal.csv', LEDGER_HEADER, 'amount');
    const bank = loadRelation(opts.dir, 'bank.csv', LEDGER_HEADER, 'amount');
    const fee = toFeeRows(loadRelation(opts.dir, 'fee.csv', FEE_HEADER, 'fee'));
    const { result, plan } = reconcile({ internal, bank, fee, useIndex: opts.useIndex });
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(opts.explain, plan);
    return 0;
  } catch (err) {
    if (err instanceof ReconError) {
      process.stderr.write(JSON.stringify({ code: err.code, message: err.message }) + '\n');
      return err.code === 'E_USAGE' ? 2 : 1;
    }
    throw err;
  }
}

module.exports = { run };
