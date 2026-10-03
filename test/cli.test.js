'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'settle.js');

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-'));
  for (const [name, rows] of Object.entries(files)) {
    const text = rows.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(path.join(dir, name), text === '' ? '' : `${text}\n`);
  }
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const ACCOUNTS = [
  { account_id: 'A', name: 'Alpha' },
  { account_id: 'B', name: 'Beta' },
];

const TRADES = [
  { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 100, fee: 5 },
  { trade_id: 't2', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: -40, fee: null },
  { trade_id: 't3', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 10, fee: null },
  { trade_id: 't4', ccy: 'EUR', counterparty: 'B', trade_date: '2026-10-01', amount: 7, fee: null },
];

const EVENTS = [
  { type: 'cancel', trade_id: 't3' },
  { type: 'cancel', trade_id: 't3' }, // duplicate reversal: idempotent
];

test('CLI settle: normal run with NULL fee and duplicate reversal', () => {
  const dir = makeDir({ 'accounts.jsonl': ACCOUNTS, 'trades.jsonl': TRADES, 'events.jsonl': EVENTS });
  const out = path.join(dir, 'out.json');
  const cert = path.join(dir, 'cert.json');
  const res = runCli(['--in', dir, '--out', out, '--cert', cert]);
  assert.equal(res.status, 0, res.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(doc.row_count, 2);
  assert.deepEqual(doc.rows[0], {
    ccy: 'EUR', counterparty: 'B', trade_date: '2026-10-01',
    net_amount: 7, fee_total: null, trade_count: 1,
  });
  assert.deepEqual(doc.rows[1], {
    ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01',
    net_amount: 60, fee_total: 5, trade_count: 2,
  });
  const certDoc = JSON.parse(fs.readFileSync(cert, 'utf8'));
  assert.equal(certDoc.row_count, 2);
  assert.ok(certDoc.inputs['trades.jsonl']);
});

test('CLI verify: ok on untouched output, fails after tampering one row', () => {
  const dir = makeDir({ 'accounts.jsonl': ACCOUNTS, 'trades.jsonl': TRADES, 'events.jsonl': EVENTS });
  const out = path.join(dir, 'out.json');
  const cert = path.join(dir, 'cert.json');
  assert.equal(runCli(['--in', dir, '--out', out, '--cert', cert]).status, 0);
  const ok = runCli(['verify', '--in', dir, '--out', out, '--cert', cert]);
  assert.equal(ok.status, 0, ok.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  doc.rows[0].net_amount = 999;
  fs.writeFileSync(out, JSON.stringify(doc));
  const bad = runCli(['verify', '--in', dir, '--out', out, '--cert', cert]);
  assert.notEqual(bad.status, 0);
  const err = JSON.parse(bad.stderr);
  assert.equal(err.code, 'E_CERT_MISMATCH');
});

test('CLI: duplicate trade_id exits non-zero with E_DUP_TRADE JSON on stderr', () => {
  const dir = makeDir({
    'accounts.jsonl': ACCOUNTS,
    'trades.jsonl': [TRADES[0], TRADES[0]],
    'events.jsonl': [],
  });
  const res = runCli(['--in', dir, '--out', path.join(dir, 'o.json'), '--cert', path.join(dir, 'c.json')]);
  assert.notEqual(res.status, 0);
  const err = JSON.parse(res.stderr);
  assert.equal(err.code, 'E_DUP_TRADE');
  assert.ok(typeof err.message === 'string');
});

test('CLI: NULL in required field exits non-zero with E_BAD_NULL', () => {
  const dir = makeDir({
    'accounts.jsonl': ACCOUNTS,
    'trades.jsonl': [{ trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: null }],
    'events.jsonl': [],
  });
  const res = runCli(['--in', dir, '--out', path.join(dir, 'o.json'), '--cert', path.join(dir, 'c.json')]);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'E_BAD_NULL');
});

test('CLI: empty inputs produce empty result and verifiable cert', () => {
  const dir = makeDir({ 'accounts.jsonl': [], 'trades.jsonl': [], 'events.jsonl': [] });
  const out = path.join(dir, 'out.json');
  const cert = path.join(dir, 'cert.json');
  const res = runCli(['--in', dir, '--out', out, '--cert', cert]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).row_count, 0);
  assert.equal(runCli(['verify', '--in', dir, '--out', out, '--cert', cert]).status, 0);
});

test('CLI: malformed JSON line exits non-zero with E_BAD_JSON', () => {
  const dir = makeDir({ 'accounts.jsonl': ACCOUNTS, 'events.jsonl': [] });
  fs.writeFileSync(path.join(dir, 'trades.jsonl'), '{"trade_id": "t1"\n');
  const res = runCli(['--in', dir, '--out', path.join(dir, 'o.json'), '--cert', path.join(dir, 'c.json')]);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'E_BAD_JSON');
});

test('CLI: unknown counterparty exits non-zero with E_UNKNOWN_ACCOUNT', () => {
  const dir = makeDir({
    'accounts.jsonl': ACCOUNTS,
    'trades.jsonl': [{ trade_id: 't1', ccy: 'USD', counterparty: 'ZZZ', trade_date: '2026-10-01', amount: 1 }],
    'events.jsonl': [],
  });
  const res = runCli(['--in', dir, '--out', path.join(dir, 'o.json'), '--cert', path.join(dir, 'c.json')]);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'E_UNKNOWN_ACCOUNT');
});
