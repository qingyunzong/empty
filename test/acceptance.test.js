import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileContract, runOrders } from '../src/runtime.js';
import { buildCert, verifyCertificate } from '../src/cert.js';

const CONTRACT_PATH = new URL('../examples/contract.fee', import.meta.url);
const SOURCE = readFileSync(CONTRACT_PATH, 'utf8');

// ---------- acceptance 1: HALF_EVEN boundaries 0.005 / 0.015 ----------
test('acceptance 1: HALF_EVEN boundary 0.005 -> 0.00, 0.015 -> 0.02', () => {
  const src = `
    currency CNY;
    rounding HALF_EVEN;
    class A { fee subscribe(amount: money) -> money { return amount * 5bps; } }
  `;
  const c = compileContract(src);
  const r1 = runOrders(c, [{ id: 'x', class: 'A', op: 'subscribe', args: { amount: '10.00' } }]).results[0];
  const r2 = runOrders(c, [{ id: 'y', class: 'A', op: 'subscribe', args: { amount: '30.00' } }]).results[0];
  assert.equal(r1.fee, '0.00'); // 0.005 -> ties to even -> 0.00
  assert.equal(r2.fee, '0.02'); // 0.015 -> ties to even -> 0.02
});

// ---------- acceptance 2: three-way tier tie, all listed ----------
test('acceptance 2: three tied tiers all reported, lowest fee chosen', () => {
  const src = `
    currency CNY;
    rounding HALF_EVEN;
    class A { fee subscribe(amount: money) -> money {
      let gross = tier on amount {
        it >= 100.00 -> 10.00,
        it < 1000.00 -> 10.00,
        else -> 10.00
      };
      return gross;
    } }
  `;
  const r = runOrders(compileContract(src), [{ id: 't', class: 'A', op: 'subscribe', args: { amount: '500.00' } }]).results[0];
  assert.equal(r.fee, '10.00');
  assert.equal(r.tiers[0].ties.length, 3);
  assert.deepEqual(r.tiers[0].ties, ['arm0', 'arm1', 'else']);
});

// ---------- acceptance 3: total != sum of parts -> E_CONSERVE ----------
test('acceptance 3: total fee != sum of components raises E_CONSERVE', () => {
  const src = `
    class A { fee subscribe(amount: money) -> money {
      let ta = 10.00;
      let channel = 20.00;
      let total = 25.00;
      conserve total == ta + channel;
      return total;
    } }
  `;
  const [r] = runOrders(compileContract(src), [{ id: 'c', class: 'A', op: 'subscribe', args: { amount: '1.00' } }]).results;
  assert.equal(r.error.code, 'E_CONSERVE');
});

// ---------- acceptance 4: 500 random orders vs independent BigInt reference + cert replay ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference implementation (BigInt only, no engine imports).
const refDivRound = (v, s, mode) => {
  const q = v / s;
  const r = v % s;
  if (r === 0n) return q;
  const ar = r < 0n ? -r : r;
  const sign = v < 0n ? -1n : 1n;
  if (mode === 'HALF_UP' && ar * 2n >= s) return q + sign;
  if (mode === 'HALF_EVEN' && (ar * 2n > s || (ar * 2n === s && q % 2n !== 0n))) return q + sign;
  return q;
};
const refMoney = (s) => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] === '-' ? -cents : cents;
};
function refOrder(order) {
  const minSub = order.params?.min_sub_fee ? refMoney(order.params.min_sub_fee) : 500n;
  const minRed = order.params?.min_red_fee ? refMoney(order.params.min_red_fee) : 100n;
  let total;
  if (order.op === 'subscribe') {
    const amount = refMoney(order.args.amount);
    const rate = amount < 100000000n ? 120n : amount < 500000000n ? 100n : 80n;
    total = refDivRound(amount * rate, 10000n, 'HALF_EVEN');
    if (total < minSub) total = minSub;
  } else {
    const amount = BigInt(order.args.shares) * refMoney(order.args.nav);
    const days = BigInt(order.args.held_days);
    const rate = days < 7n ? 150n : days < 365n ? 50n : 10n;
    total = refDivRound(amount * rate, 10000n, 'HALF_EVEN');
    if (total < minRed) total = minRed;
  }
  const ta = refDivRound(total * 6000n, 10000n, 'HALF_EVEN');
  const channel = refDivRound(total * 4000n, 10000n, 'HALF_EVEN');
  return { total, ta, channel, residual: total - ta - channel };
}

const fmtCents = (c) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;

function randomOrders(count, seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const orders = [];
  for (let i = 0; i < count; i += 1) {
    if (rand() < 0.5) {
      let cents;
      const roll = rand();
      if (roll < 0.1) cents = pick([100000000n, 500000000n]); // tier boundaries
      else if (roll < 0.25) cents = BigInt(1 + Math.floor(rand() * 1000)); // tiny -> min fee
      else cents = BigInt(1 + Math.floor(rand() * 2_000_000_000));
      const order = { id: `sub${i}`, class: 'A', op: 'subscribe', args: { amount: fmtCents(cents) } };
      if (rand() < 0.3) order.params = { min_sub_fee: pick(['3.00', '5.00', '10.00']) };
      orders.push(order);
    } else {
      const shares = BigInt(1 + Math.floor(rand() * 2_000_000));
      const navCents = BigInt(50 + Math.floor(rand() * 4950));
      let days;
      const roll = rand();
      if (roll < 0.15) days = pick([0n, 7n, 365n]); // tier boundaries
      else days = BigInt(Math.floor(rand() * 2000));
      const order = {
        id: `red${i}`,
        class: 'A',
        op: 'redeem',
        args: { shares: String(shares), nav: fmtCents(navCents), held_days: String(days) },
      };
      if (rand() < 0.3) order.params = { min_red_fee: pick(['1.00', '2.00']) };
      orders.push(order);
    }
  }
  return orders;
}

test('acceptance 4: 500 random orders match independent BigInt reference; certificate replays', () => {
  const contract = compileContract(SOURCE);
  const orders = randomOrders(500, 20261004);
  const ordersRaw = { orders };
  const { results } = runOrders(contract, ordersRaw);

  for (let i = 0; i < orders.length; i += 1) {
    const r = results[i];
    assert.ok(!r.error, `order ${orders[i].id} failed: ${r.error?.message}`);
    const ref = refOrder(orders[i]);
    assert.equal(r.feeCents, String(ref.total), `fee mismatch at ${r.id}`);
    const alloc = r.allocations[0];
    assert.equal(alloc.components.ta, String(ref.ta), `ta mismatch at ${r.id}`);
    assert.equal(alloc.components.channel, String(ref.channel), `channel mismatch at ${r.id}`);
    assert.equal(alloc.residual.amount, String(ref.residual), `residual mismatch at ${r.id}`);
    assert.equal(alloc.residual.account, 'TA_POOL');
    // conservation holds for every order
    const sum = BigInt(alloc.components.ta) + BigInt(alloc.components.channel) + BigInt(alloc.residual.amount);
    assert.equal(sum, BigInt(alloc.total));
  }

  // certificate replay verifies
  const cert = buildCert(contract, ordersRaw, results);
  assert.equal(verifyCertificate(SOURCE, ordersRaw, cert), true);

  // tampered rounding step -> E_ROUND
  const tamperedRound = JSON.parse(JSON.stringify(cert));
  const victim = tamperedRound.orders.find((o) => o.trace.some((s) => s.op === 'ROUND'));
  const step = victim.trace.find((s) => s.op === 'ROUND');
  step.out = String(BigInt(step.out) + 1n);
  assert.throws(() => verifyCertificate(SOURCE, ordersRaw, tamperedRound), (e) => e.code === 'E_ROUND');

  // tampered allocation -> E_CONSERVE
  const tamperedAlloc = JSON.parse(JSON.stringify(cert));
  const victim2 = tamperedAlloc.orders.find((o) => o.allocations.length > 0);
  victim2.allocations[0].components.ta = String(BigInt(victim2.allocations[0].components.ta) + 1n);
  assert.throws(() => verifyCertificate(SOURCE, ordersRaw, tamperedAlloc), (e) => e.code === 'E_CONSERVE');

  // wrong orders -> E_CERT
  const otherOrders = { orders: orders.slice(1) };
  assert.throws(() => verifyCertificate(SOURCE, otherOrders, cert), (e) => e.code === 'E_CERT');
});
