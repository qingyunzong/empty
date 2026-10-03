import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileContract, runOrder } from '../src/runtime.js';
import { divRound } from '../src/vm.js';

const feeOf = (src, order) => runOrder(compileContract(src), order);

test('divRound implements HALF_UP / HALF_EVEN / DOWN on integer cents', () => {
  // 0.005 = 5000 / 10000 of a cent-scale unit
  assert.deepEqual(divRound(5000n, 10000n, 'HALF_EVEN'), { q: 0n, r: 5000n });
  assert.deepEqual(divRound(15000n, 10000n, 'HALF_EVEN'), { q: 2n, r: 5000n });
  assert.deepEqual(divRound(25000n, 10000n, 'HALF_EVEN'), { q: 2n, r: 5000n });
  assert.deepEqual(divRound(5000n, 10000n, 'HALF_UP'), { q: 1n, r: 5000n });
  assert.deepEqual(divRound(19000n, 10000n, 'DOWN'), { q: 1n, r: 9000n });
  assert.deepEqual(divRound(-5000n, 10000n, 'HALF_UP'), { q: -1n, r: -5000n });
  assert.deepEqual(divRound(-15000n, 10000n, 'HALF_EVEN'), { q: -2n, r: -5000n });
});

const roundContract = (mode) => `
  currency CNY;
  rounding ${mode};
  class A {
    fee subscribe(amount: money) -> money {
      return amount * 5bps;
    }
  }
`;

test('HALF_EVEN boundary: 0.005 rounds to 0.00, 0.015 rounds to 0.02', () => {
  const c = compileContract(roundContract('HALF_EVEN'));
  assert.equal(runOrder(c, { id: 'a', class: 'A', op: 'subscribe', args: { amount: '10.00' } }).fee, '0.00');
  assert.equal(runOrder(c, { id: 'b', class: 'A', op: 'subscribe', args: { amount: '30.00' } }).fee, '0.02');
  assert.equal(runOrder(c, { id: 'c', class: 'A', op: 'subscribe', args: { amount: '50.00' } }).fee, '0.02');
  const r = runOrder(c, { id: 'd', class: 'A', op: 'subscribe', args: { amount: '30.00' } });
  const roundStep = r.trace.find((s) => s.op === 'ROUND');
  assert.equal(roundStep.in, '15000');
  assert.equal(roundStep.rem, '5000');
  assert.equal(roundStep.out, '2');
});

test('HALF_UP and DOWN modes', () => {
  const up = compileContract(roundContract('HALF_UP'));
  assert.equal(runOrder(up, { id: 'a', class: 'A', op: 'subscribe', args: { amount: '10.00' } }).fee, '0.01');
  const down = compileContract(roundContract('DOWN'));
  assert.equal(runOrder(down, { id: 'b', class: 'A', op: 'subscribe', args: { amount: '38.00' } }).fee, '0.01');
  assert.equal(runOrder(down, { id: 'c', class: 'A', op: 'subscribe', args: { amount: '10.00' } }).fee, '0.00');
});

const tieContract = (arms) => `
  currency CNY;
  rounding HALF_EVEN;
  class A {
    fee subscribe(amount: money) -> money {
      let gross = tier on amount {
        ${arms}
      };
      return gross;
    }
  }
`;

test('three-way tier tie: lowest fee chosen, all ties listed', () => {
  const src = tieContract(`
    it >= 100.00 -> 10.00,
    it < 1000.00 -> 10.00,
    else -> 10.00
  `);
  const r = feeOf(src, { id: 't', class: 'A', op: 'subscribe', args: { amount: '500.00' } });
  assert.equal(r.fee, '10.00');
  assert.equal(r.tiers.length, 1);
  assert.deepEqual(r.tiers[0].matches.map((m) => m.arm), ['arm0', 'arm1', 'else']);
  assert.deepEqual(r.tiers[0].ties, ['arm0', 'arm1', 'else']);
});

test('overlapping tiers: lowest fee wins, only lowest listed as tie', () => {
  const src = tieContract(`
    it >= 100.00 -> 12.00,
    it < 1000.00 -> 10.00,
    else -> 9.00
  `);
  const r = feeOf(src, { id: 't', class: 'A', op: 'subscribe', args: { amount: '500.00' } });
  assert.equal(r.fee, '9.00');
  assert.equal(r.tiers[0].matches.length, 3);
  assert.deepEqual(r.tiers[0].ties, ['else']);
});

test('no tier matched and no else arm raises E_TIER', () => {
  const src = tieContract('it > 1000.00 -> 1.00');
  assert.throws(
    () => feeOf(src, { id: 't', class: 'A', op: 'subscribe', args: { amount: '100.00' } }),
    (e) => e.code === 'E_TIER',
  );
});

test('conserve statement raises E_CONSERVE when total != sum of parts', () => {
  const bad = `
    class A { fee subscribe(amount: money) -> money {
      let a = 10.00;
      let b = 20.00;
      let total = 25.00;
      conserve total == a + b;
      return total;
    } }
  `;
  assert.throws(
    () => feeOf(bad, { id: 'c', class: 'A', op: 'subscribe', args: { amount: '1.00' } }),
    (e) => e.code === 'E_CONSERVE',
  );
  const good = `
    class A { fee subscribe(amount: money) -> money {
      let a = 10.00;
      let b = 20.00;
      let total = 30.00;
      conserve total == a + b;
      return total;
    } }
  `;
  assert.equal(feeOf(good, { id: 'c', class: 'A', op: 'subscribe', args: { amount: '1.00' } }).fee, '30.00');
});

test('allocate sends rounding dust to the residual account', () => {
  const src = `
    currency CNY;
    rounding HALF_EVEN;
    class A { fee subscribe(amount: money) -> money {
      let total = 0.03;
      allocate total {
        ta: 6000bps;
        channel: 4000bps;
        residual -> "TA_POOL";
      }
      return total;
    } }
  `;
  const r = feeOf(src, { id: 'a', class: 'A', op: 'subscribe', args: { amount: '1.00' } });
  const alloc = r.allocations[0];
  assert.equal(alloc.total, '3');
  assert.equal(alloc.components.ta, '2');   // 3 * 0.6 = 1.8 -> 2 (HALF_EVEN)
  assert.equal(alloc.components.channel, '1'); // 3 * 0.4 = 1.2 -> 1
  assert.equal(alloc.residual.account, 'TA_POOL');
  assert.equal(alloc.residual.amount, '0');
  const sum = BigInt(alloc.components.ta) + BigInt(alloc.components.channel) + BigInt(alloc.residual.amount);
  assert.equal(sum, BigInt(alloc.total));
});

test('allocate shares above 100% raise E_CONSERVE', () => {
  const src = `
    class A { fee subscribe(amount: money) -> money {
      let total = 100.00;
      allocate total {
        ta: 6000bps;
        channel: 5000bps;
        residual -> "TA_POOL";
      }
      return total;
    } }
  `;
  assert.throws(
    () => feeOf(src, { id: 'a', class: 'A', op: 'subscribe', args: { amount: '1.00' } }),
    (e) => e.code === 'E_CONSERVE',
  );
});

test('negative redemption, zero shares and over-precision literals are rejected', () => {
  const src = `
    class A {
      fee redeem(shares: units, nav: money) -> money { return shares * nav; }
    }
  `;
  const c = compileContract(src);
  assert.throws(
    () => runOrder(c, { id: 'n', class: 'A', op: 'redeem', args: { shares: '-10', nav: '1.00' } }),
    (e) => e.code === 'E_DOMAIN',
  );
  assert.throws(
    () => runOrder(c, { id: 'z', class: 'A', op: 'redeem', args: { shares: '0', nav: '1.00' } }),
    (e) => e.code === 'E_DOMAIN',
  );
  assert.throws(
    () => runOrder(c, { id: 'p', class: 'A', op: 'redeem', args: { shares: '10', nav: '1.234' } }),
    (e) => e.code === 'E_LEX',
  );
});

test('class-level default params are overridden per order', () => {
  const src = `
    class A {
      param min_fee = 5.00;
      fee subscribe(amount: money) -> money {
        return max(amount * 120bps, min_fee);
      }
    }
  `;
  const c = compileContract(src);
  const def = runOrder(c, { id: 'd', class: 'A', op: 'subscribe', args: { amount: '10.00' } });
  assert.equal(def.fee, '5.00');
  const ovr = runOrder(c, { id: 'o', class: 'A', op: 'subscribe', args: { amount: '10.00' }, params: { min_fee: '3.00' } });
  assert.equal(ovr.fee, '3.00');
  assert.throws(
    () => runOrder(c, { id: 'x', class: 'A', op: 'subscribe', args: { amount: '10.00' }, params: { nope: '1.00' } }),
    (e) => e.code === 'E_ORDER',
  );
});
