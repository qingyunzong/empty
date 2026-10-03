import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSource } from '../src/compiler.js';
import { VM, normalizeOrder } from '../src/vm.js';
import { buildCertificate, verifyCertificate } from '../src/cert.js';
import { runCli } from '../src/cli.js';

const CONTRACT = `
contract "EquityFund-A" {
  defaults { rate = 25bps floor = 1.00 CNY }
  rounding HALF_EVEN
  residual to TAIL_ACCOUNT
  fee = {
    tier on [0.00 CNY, 1000000.00 CNY) fee = rate min floor
    tier on [1000000.00 CNY, 5000000.00 CNY) fee = 15bps
    tier on [5000000.00 CNY, ) fee = 10bps max 5000.00 CNY
  }
}`;

// ---- independent BigInt reference implementation (no src imports) ----
// amounts are integers in 1e-4 units; fees exact rationals num/den.
function refFeeCents(amountE4, rateBps) {
  const E8 = 100000000n;
  let num, den = E8;
  const tierOf = (a) => (a < 10000000000n ? 0 : a < 50000000000n ? 1 : 2);
  const tier = tierOf(amountE4);
  const rate = tier === 0 ? rateBps : tier === 1 ? 15n : 10n;
  num = amountE4 * rate; // fee = num / 1e8
  if (tier === 0) {
    const floor = 100000000n; // 1.00 in 1e-8
    if (num < floor) num = floor;
  }
  if (tier === 2) {
    const cap = 500000000000n; // 5000.00 in 1e-8
    if (num > cap) num = cap;
  }
  // HALF_EVEN round num/den to cents (1e-2): scale num by 100 -> per 1e-2
  const scaled = num * 100n;
  let q = scaled / den;
  const r = scaled % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && q % 2n !== 0n)) q += 1n;
  return q; // integer cents
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('500 random orders match independent BigInt reference and certificates replay', () => {
  const program = compileSource(CONTRACT);
  const vm = new VM(program);
  const rand = mulberry32(20261003);
  const boundaries = ['0.00', '1000000.00', '5000000.00', '999999.9999', '1000000.0001', '4999999.9999'];

  for (let i = 0; i < 500; i++) {
    let amountStr;
    if (i < boundaries.length) {
      amountStr = boundaries[i];
    } else {
      // random amount in [0, 20_000_000] with up to 4 decimals
      const e4 = BigInt(Math.floor(rand() * 2e11));
      amountStr = `${e4 / 10000n}.${(e4 % 10000n).toString().padStart(4, '0')}`;
    }
    const overrideRate = rand() < 0.3 ? `${1 + Math.floor(rand() * 50)}bps` : null;
    const raw = {
      id: `ord-${i}`,
      amount: amountStr,
      ...(overrideRate ? { overrides: { rate: overrideRate } } : {}),
    };
    const order = normalizeOrder(raw, program);
    const result = vm.execute(order);

    // reference check
    const [iPart, fPart = ''] = amountStr.split('.');
    const amountE4 = BigInt(iPart + (fPart + '0000').slice(0, 4));
    const rateBps = overrideRate ? BigInt(overrideRate.replace('bps', '')) : 25n;
    const expectedCents = refFeeCents(amountE4, rateBps);
    const actualCents = BigInt(result.totalFee.replace('.', ''));
    assert.equal(actualCents, expectedCents, `order ${i} amount=${amountStr} rate=${overrideRate ?? 'default'}`);

    // certificate build + replay
    const cert = buildCertificate(program, CONTRACT, order, result);
    assert.ok(verifyCertificate(CONTRACT, cert), `certificate replay failed for order ${i}`);
    assert.ok(cert.steps.some((s) => s.op === 'ROUND' && 'remainder' in s));
    const conserve = cert.steps.find((s) => s.op === 'CONSERVE');
    assert.equal(conserve.identityHolds, true);
  }
});

test('tampered certificate fails replay with E_CONSERVE', () => {
  const program = compileSource(CONTRACT);
  const vm = new VM(program);
  const order = normalizeOrder({ id: 'x', amount: '10000.00' }, program);
  const cert = buildCertificate(program, CONTRACT, order, vm.execute(order));
  cert.totalFee = '24.99';
  assert.throws(() => verifyCertificate(CONTRACT, cert), /E_CONSERVE/);
});

test('CLI calc writes certificates and verify replays them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-e2e-'));
  const contractPath = join(dir, 'contract.fee');
  const ordersPath = join(dir, 'orders.json');
  writeFileSync(contractPath, CONTRACT);
  writeFileSync(ordersPath, JSON.stringify({
    orders: [
      { id: 'A1', amount: '100.00' },
      { id: 'A2', amount: '2500000.00' },
      { id: 'A3', amount: '12345.6789', overrides: { rate: '20bps' } },
    ],
  }));
  const out = [];
  const code = runCli(['calc', contractPath, ordersPath, '--cert'], { out: (s) => out.push(s), err: (s) => out.push(s) });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /A1: fee=1\.00 CNY/);
  assert.match(text, /A2: fee=3750\.00 CNY/);
  assert.match(text, /A3: fee=24\.69 CNY residual=0\.0013578 -> TAIL_ACCOUNT/);
  const certPath = join(dir, 'orders.cert.json');
  assert.ok(existsSync(certPath));
  const vout = [];
  const vcode = runCli(['verify', contractPath, certPath], { out: (s) => vout.push(s), err: (s) => vout.push(s) });
  assert.equal(vcode, 0);
  assert.match(vout.join('\n'), /verified 3 certificate\(s\)/);
});

test('CLI exits non-zero with error code on lex errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-e2e-'));
  const contractPath = join(dir, 'bad.fee');
  const ordersPath = join(dir, 'orders.json');
  writeFileSync(contractPath, 'contract "B" { rounding HALF_UP residual to T fee = 1.12345 CNY }');
  writeFileSync(ordersPath, JSON.stringify({ orders: [{ id: 'x', amount: '1.00' }] }));
  const errs = [];
  const code = runCli(['calc', contractPath, ordersPath], { out: () => {}, err: (s) => errs.push(s) });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /E_LEX/);
});
