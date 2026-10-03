import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const ROOT = new URL('..', import.meta.url).pathname;
const CONTRACT = join(ROOT, 'examples', 'contract.fee');
const ORDERS = join(ROOT, 'examples', 'orders.json');

const run = runCli;

test('fee calc prints results and writes a certificate with --cert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-cli-'));
  const certPath = join(dir, 'out.cert.json');
  const r = run(['calc', CONTRACT, ORDERS, `--cert=${certPath}`]);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results.length, 5);
  assert.equal(report.results[0].fee, '120.00');
  assert.equal(report.results[1].fee, '5.00'); // min fee floor
  const cert = JSON.parse(readFileSync(certPath, 'utf8'));
  assert.equal(cert.version, 1);
  assert.equal(cert.orders.length, 5);

  const v = run(['verify', CONTRACT, ORDERS, certPath]);
  assert.equal(v.code, 0, v.stderr);
  assert.equal(v.stdout.trim(), 'OK');
});

test('fee verify rejects a tampered certificate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-cli-'));
  const certPath = join(dir, 'out.cert.json');
  run(['calc', CONTRACT, ORDERS, `--cert=${certPath}`]);
  const cert = JSON.parse(readFileSync(certPath, 'utf8'));
  const victim = cert.orders.find((o) => o.trace.some((s) => s.op === 'ROUND'));
    victim.trace.find((s) => s.op === 'ROUND').out = '999999';
  writeFileSync(certPath, JSON.stringify(cert));
  const v = run(['verify', CONTRACT, ORDERS, certPath]);
  assert.equal(v.code, 1);
  assert.match(v.stderr, /E_ROUND/);
});

test('fee calc reports order errors with codes and exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-cli-'));
  const badOrders = join(dir, 'bad.json');
  writeFileSync(badOrders, JSON.stringify({
    orders: [
      { id: 'bad1', class: 'A', op: 'redeem', args: { shares: '0', nav: '1.00', held_days: '10' } },
      { id: 'bad2', class: 'A', op: 'subscribe', args: { amount: '1.001' } },
      { id: 'ok1', class: 'A', op: 'subscribe', args: { amount: '100.00' } },
    ],
  }));
  const r = run(['calc', CONTRACT, badOrders]);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results[0].error.code, 'E_DOMAIN');
  assert.equal(report.results[1].error.code, 'E_LEX');
  assert.equal(report.results[2].fee, '5.00');
});

test('fee calc rejects a broken contract with E_LEX', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-cli-'));
  const bad = join(dir, 'bad.fee');
  writeFileSync(bad, 'class A { fee subscribe(amount: money) -> money { return 1.001; } }');
  const r = run(['calc', bad, ORDERS]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_LEX/);
});
