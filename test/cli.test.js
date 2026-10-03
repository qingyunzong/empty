import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

function makeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'settle-'));
  const inDir = join(dir, 'in');
  mkdirSync(inDir);
  writeFileSync(join(inDir, 'accounts.jsonl'), files.accounts ?? '');
  writeFileSync(join(inDir, 'trades.jsonl'), files.trades ?? '');
  writeFileSync(join(inDir, 'events.jsonl'), files.events ?? '');
  return { dir, inDir, out: join(dir, 'out.json'), cert: join(dir, 'cert.json') };
}

// Run the CLI in-process, capturing stdout/stderr and the exit code.
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const code = run(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

const ACCOUNTS = [
  { counterparty: 'CP1', name: 'Alice' },
  { counterparty: 'CP2', name: 'Bob' },
].map(JSON.stringify).join('\n') + '\n';

const TRADES = [
  { trade_id: 't1', counterparty: 'CP1', currency: 'USD', trade_date: '2026-10-01', amount: 100, fee: 10 },
  { trade_id: 't2', counterparty: 'CP1', currency: 'USD', trade_date: '2026-10-01', amount: -40, fee: null },
  { trade_id: 't3', counterparty: 'CP2', currency: 'EUR', trade_date: '2026-10-01', amount: 25, fee: null },
  { trade_id: 't4', counterparty: 'CP2', currency: 'EUR', trade_date: '2026-10-01', amount: 25, fee: 3 },
].map(JSON.stringify).join('\n') + '\n';

const EVENTS = [
  { op: 'revoke', trade_id: 't4' }, // 冲正
  { op: 'insert', trade: { trade_id: 't5', counterparty: 'CP1', currency: 'USD', trade_date: '2026-10-02', amount: 7, fee: 1 } },
].map(JSON.stringify).join('\n') + '\n';

test('CLI: settle writes out.json and cert.json, exit 0', () => {
  const { inDir, out, cert } = makeDir({ accounts: ACCOUNTS, trades: TRADES, events: EVENTS });
  const r = runCli(['settle', '--in', inDir, '--out', out, '--cert', cert]);
  assert.equal(r.code, 0, r.stderr);
  const outJson = JSON.parse(readFileSync(out, 'utf8'));
  const certJson = JSON.parse(readFileSync(cert, 'utf8'));
  assert.equal(outJson.rows.length, 3);
  const cp1 = outJson.rows.find((x) => x.counterparty === 'CP1' && x.trade_date === '2026-10-01');
  assert.equal(cp1.net_amount, 60);
  assert.equal(cp1.fee_sum, 10);
  const cp2 = outJson.rows.find((x) => x.counterparty === 'CP2');
  assert.equal(cp2.net_amount, 25);
  assert.equal(cp2.fee_sum, null); // only NULL-fee trade left after revoke
  assert.equal(certJson.row_count, 3);
  assert.equal(certJson.inputs.trades.length, 64);
  const v = runCli(['verify', '--cert', cert]);
  assert.equal(v.code, 0, v.stderr);
  assert.deepEqual(JSON.parse(v.stdout).ok, true);
});

test('CLI: tampered certificate fails verify with E_CERT_TAMPER', () => {
  const { inDir, out, cert } = makeDir({ accounts: ACCOUNTS, trades: TRADES, events: EVENTS });
  runCli(['settle', '--in', inDir, '--out', out, '--cert', cert]);
  const certJson = JSON.parse(readFileSync(cert, 'utf8'));
  certJson.rows[0].net_amount += 1; // tamper one row
  writeFileSync(cert, JSON.stringify(certJson));
  const v = runCli(['verify', '--cert', cert]);
  assert.notEqual(v.code, 0);
  const err = JSON.parse(v.stderr);
  assert.equal(err.code, 'E_CERT_TAMPER');
  assert.equal(typeof err.message, 'string');
});

test('CLI: duplicate trade_id -> exit!=0, stderr {code,message}', () => {
  const dup = TRADES + JSON.stringify({ trade_id: 't1', counterparty: 'CP1', currency: 'USD', trade_date: '2026-10-01', amount: 1, fee: null }) + '\n';
  const { inDir, out, cert } = makeDir({ accounts: ACCOUNTS, trades: dup, events: '' });
  const r = runCli(['settle', '--in', inDir, '--out', out, '--cert', cert]);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(r.stderr).code, 'E_DUP_TRADE');
});

test('CLI: NULL in required field -> E_BAD_NULL', () => {
  const bad = JSON.stringify({ trade_id: 't1', counterparty: 'CP1', currency: 'USD', trade_date: '2026-10-01', amount: null, fee: 1 }) + '\n';
  const { inDir, out, cert } = makeDir({ accounts: ACCOUNTS, trades: bad, events: '' });
  const r = runCli(['settle', '--in', inDir, '--out', out, '--cert', cert]);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(r.stderr).code, 'E_BAD_NULL');
});

test('CLI: invalid JSON -> E_PARSE; missing args -> E_ARGS', () => {
  const { inDir, out, cert } = makeDir({ accounts: ACCOUNTS, trades: '{not json}\n', events: '' });
  const r = runCli(['settle', '--in', inDir, '--out', out, '--cert', cert]);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(r.stderr).code, 'E_PARSE');
  const r2 = runCli(['settle', '--in', inDir]);
  assert.notEqual(r2.code, 0);
  assert.equal(JSON.parse(r2.stderr).code, 'E_ARGS');
});

test('CLI: empty inputs -> empty rows, valid empty certificate', () => {
  const { inDir, out, cert } = makeDir({});
  const r = runCli(['settle', '--in', inDir, '--out', out, '--cert', cert]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).rows, []);
  const v = runCli(['verify', '--cert', cert]);
  assert.equal(v.code, 0, v.stderr);
});
