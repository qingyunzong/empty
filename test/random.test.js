'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guard, applyEvent, createState, project, projectionOf } = require('../lib/model');
const ref = require('./helpers/reference');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = ['A', 'B', 'C'];

function randomEvent(rng, sysState, counters) {
  const roll = rng();
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const saleIds = Object.keys(sysState.sales);
  const refundIds = Object.keys(sysState.refunds);
  if (roll < 0.22 || saleIds.length === 0) {
    counters.sale += 1;
    return { type: 'sale', id: `s${counters.sale}`, account: pick(ACCOUNTS), amount: 1 + Math.floor(rng() * 30) };
  }
  if (roll < 0.38) {
    counters.refund += 1;
    // sometimes dangling on purpose
    const refId = rng() < 0.15 ? `ghost${counters.refund}` : pick(saleIds);
    const sale = sysState.sales[refId];
    const maxAmt = sale ? sale.amount : 10;
    // sometimes over-refund on purpose
    const amount = 1 + Math.floor(rng() * (rng() < 0.2 ? maxAmt + 5 : maxAmt));
    return { type: 'refund', id: `r${counters.refund}`, ref: refId, amount };
  }
  if (roll < 0.55 && refundIds.length > 0) {
    // refundVoid: mostly real refunds, sometimes dangling
    const refId = rng() < 0.1 ? `ghostv${counters.void}` : pick(refundIds);
    counters.void += 1;
    return { type: 'refundVoid', ref: refId };
  }
  if (roll < 0.75) {
    return { type: 'freeze', account: pick(ACCOUNTS), amount: 1 + Math.floor(rng() * 15) };
  }
  if (roll < 0.9) {
    return { type: 'unfreeze', account: pick(ACCOUNTS), amount: 1 + Math.floor(rng() * 15) };
  }
  // duplicate sale id on purpose
  return { type: 'sale', id: pick(saleIds), account: pick(ACCOUNTS), amount: 5 };
}

test('300 random events (incl. refundVoid): project matches reference machine', () => {
  for (const seed of [17, 1701, 20261003]) {
    const rng = mulberry32(seed);
    const sys = createState();
    const model = ref.createRef();
    const log = [];
    const counters = { sale: 0, refund: 0, void: 0 };
    const codeCounts = new Map();
    let voidsApplied = 0;

    for (let i = 0; i < 300; i += 1) {
      const event = randomEvent(rng, sys, counters);
      const g = guard(sys, event);
      const sysCode = g.ok ? 0 : g.code;
      const refCode = ref.check(model, event);
      assert.equal(sysCode, refCode,
        `seed ${seed} event ${i} ${JSON.stringify(event)}: sys=${sysCode} ref=${refCode}`);
      if (g.ok) {
        applyEvent(sys, event);
        ref.run(model, event);
        log.push(event);
        if (event.type === 'refundVoid') voidsApplied += 1;
      } else {
        codeCounts.set(sysCode, (codeCounts.get(sysCode) || 0) + 1);
      }
    }

    // projection folded from the persisted log must equal the reference model
    const projected = project(log);
    assert.deepEqual(projectionOf(projected).accounts, ref.accountsOf(model),
      `seed ${seed}: project(log) diverged from reference`);
    assert.deepEqual(projectionOf(projected).accounts, projectionOf(sys).accounts);
    assert.ok(voidsApplied > 0, `seed ${seed}: expected some refundVoid events to apply`);
    console.log(`  seed ${seed}: ${log.length}/300 applied, ${voidsApplied} refundVoids, ` +
      `rejects: ${[...codeCounts.entries()].map(([c, n]) => `${c}x${n}`).join(' ') || 'none'}`);
  }
});
