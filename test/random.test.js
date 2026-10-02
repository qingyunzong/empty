'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settle, parseEvent } = require('../lib');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference: naive full recompute per merchant+period.
function referenceSettle(events) {
  const seqOf = new Map();
  events.forEach((e, i) => seqOf.set(e, i + 1));
  const rules = events
    .filter((e) => e.type === 'rule')
    .map((e) => ({ ...e, ts: e.ts !== undefined ? e.ts : seqOf.get(e), seq: seqOf.get(e) }));

  const pick = (merchantId, productIds, beforeSeq) => {
    const elig = rules.filter((r) => r.seq < beforeSeq);
    const m = elig.filter((r) => r.scope === 'merchant' && r.merchantId === merchantId);
    let c = m.length ? m : elig.filter((r) => r.scope === 'product' && productIds.includes(r.productId));
    if (!c.length) return null;
    const maxTs = Math.max(...c.map((r) => r.ts));
    c = c.filter((r) => r.ts === maxTs);
    c.sort((a, b) => a.tiers[0].bps - b.tiers[0].bps || (a.ruleId < b.ruleId ? -1 : 1));
    return c[0];
  };

  const rebateFor = (rule, volume) => {
    if (!rule) return { rebate: 0, ruleId: null };
    let tier = rule.tiers[0];
    for (const t of rule.tiers) if (volume >= t.min) tier = t;
    return { rebate: Math.floor((volume * tier.bps) / 10000), ruleId: rule.ruleId };
  };

  const byKey = new Map();
  for (const e of events) {
    if (e.type === 'charge') {
      const key = `${e.merchantId}|${e.period}`;
      if (!byKey.has(key)) byKey.set(key, { merchantId: e.merchantId, period: e.period, charges: [], snapIdx: -1 });
      byKey.get(key).charges.push({ id: e.id, productId: e.productId, amount: e.amount, idx: seqOf.get(e) });
    } else if (e.type === 'snapshot') {
      const key = `${e.merchantId}|${e.period}`;
      if (!byKey.has(key)) byKey.set(key, { merchantId: e.merchantId, period: e.period, charges: [], snapIdx: -1 });
      byKey.get(key).snapIdx = seqOf.get(e);
    }
  }

  const reversedAt = new Map(); // chargeId -> correction seq
  for (const e of events) {
    if (e.type === 'correct') reversedAt.set(e.linksTo, seqOf.get(e));
  }

  const expected = [];
  for (const rec of byKey.values()) {
    const volOf = (chargeFilter, corrFilter) =>
      rec.charges
        .filter(chargeFilter)
        .filter((c) => {
          const corrSeq = reversedAt.get(c.id);
          return corrSeq === undefined || !corrFilter(corrSeq);
        })
        .reduce((s, c) => s + c.amount, 0);

    if (rec.snapIdx > 0) {
      const snapSeq = rec.snapIdx;
      const snapPids = [...new Set(rec.charges.filter((c) => c.idx < snapSeq).map((c) => c.productId))];
      const allPids = [...new Set(rec.charges.map((c) => c.productId))];
      const snapVol = volOf((c) => c.idx < snapSeq, (cs) => cs < snapSeq);
      const snapRule = pick(rec.merchantId, snapPids, snapSeq);
      const snapRes = rebateFor(snapRule, snapVol);
      const fullVol = volOf(() => true, () => true);
      const fullRule = pick(rec.merchantId, allPids, snapSeq);
      const fullRes = rebateFor(fullRule, fullVol);
      const postActivity = rec.charges.some((c) => c.idx > snapSeq)
        || [...reversedAt.entries()].some(([id, cs]) => cs > snapSeq && rec.charges.some((c) => c.id === id));
      expected.push({
        key: `${rec.merchantId}|${rec.period}`,
        volume: snapVol,
        rebate: snapRes.rebate,
        ruleId: snapRes.ruleId,
        supplement: postActivity
          ? { volume: fullVol, rebate: fullRes.rebate, deltaVolume: fullVol - snapVol, deltaRebate: fullRes.rebate - snapRes.rebate }
          : null,
      });
    } else {
      const pids = [...new Set(rec.charges.map((c) => c.productId))];
      const vol = volOf(() => true, () => true);
      const res = rebateFor(pick(rec.merchantId, pids, Infinity), vol);
      expected.push({ key: `${rec.merchantId}|${rec.period}`, volume: vol, rebate: res.rebate, ruleId: res.ruleId, supplement: null });
    }
  }
  return expected;
}

function generateEvents(rand, n) {
  const merchants = ['m1', 'm2', 'm3'];
  const products = ['p1', 'p2'];
  const periods = ['2026-01', '2026-02'];
  const events = [];
  const charges = [];
  const reversed = new Set();
  const snapshotted = new Set();
  let idc = 0;
  const nid = (p) => `${p}${(idc += 1)}`;

  const ruleCount = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < ruleCount; i += 1) {
    const merchantScope = rand() < 0.5;
    const tiers = [{ min: 0, bps: 50 + Math.floor(rand() * 300) }];
    if (rand() < 0.5) tiers.push({ min: 500 + Math.floor(rand() * 1000), bps: 100 + Math.floor(rand() * 400) });
    const ev = {
      type: 'rule',
      ruleId: nid('r'),
      scope: merchantScope ? 'merchant' : 'product',
      tiers,
    };
    if (merchantScope) ev.merchantId = merchants[Math.floor(rand() * merchants.length)];
    else ev.productId = products[Math.floor(rand() * products.length)];
    if (rand() < 0.7) ev.ts = 1 + Math.floor(rand() * 5);
    events.push(ev);
  }

  while (events.length < n) {
    const roll = rand();
    if (roll < 0.6 || charges.length === 0) {
      const ev = {
        type: 'charge',
        id: nid('c'),
        merchantId: merchants[Math.floor(rand() * merchants.length)],
        productId: products[Math.floor(rand() * products.length)],
        period: periods[Math.floor(rand() * periods.length)],
        amount: Math.floor(rand() * 2000),
      };
      events.push(ev);
      charges.push(ev);
    } else if (roll < 0.8) {
      const candidates = charges.filter((c) => !reversed.has(c.id));
      if (candidates.length === 0) continue;
      const target = candidates[Math.floor(rand() * candidates.length)];
      reversed.add(target.id);
      events.push({ type: 'correct', id: nid('x'), linksTo: target.id });
    } else {
      const merchantId = merchants[Math.floor(rand() * merchants.length)];
      const period = periods[Math.floor(rand() * periods.length)];
      const key = `${merchantId}|${period}`;
      if (snapshotted.has(key)) continue;
      snapshotted.add(key);
      events.push({ type: 'snapshot', id: nid('s'), merchantId, period });
    }
  }
  return events;
}

test('random replay (n<=200) matches naive full recompute', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const rand = mulberry32(seed);
    const n = 1 + Math.floor(rand() * 200);
    const raw = generateEvents(rand, n);
    const events = raw.map((e) => parseEvent(JSON.stringify(e), 0));
    const result = settle(events);
    const expected = referenceSettle(events);
    const byKey = new Map(expected.map((e) => [e.key, e]));
    assert.equal(result.periods.length, expected.length, `seed ${seed}: period count`);
    for (const p of result.periods) {
      const exp = byKey.get(`${p.merchantId}|${p.period}`);
      assert.ok(exp, `seed ${seed}: missing ${p.merchantId}|${p.period}`);
      assert.equal(p.volume, exp.volume, `seed ${seed} ${exp.key} volume`);
      assert.equal(p.rebate, exp.rebate, `seed ${seed} ${exp.key} rebate`);
      assert.equal(p.ruleId, exp.ruleId, `seed ${seed} ${exp.key} ruleId`);
      if (exp.supplement) {
        assert.equal(p.supplements.length, 1, `seed ${seed} ${exp.key} supplement count`);
        const sup = p.supplements[0];
        assert.equal(sup.volume, exp.supplement.volume, `seed ${seed} ${exp.key} sup volume`);
        assert.equal(sup.rebate, exp.supplement.rebate, `seed ${seed} ${exp.key} sup rebate`);
        assert.equal(sup.deltaVolume, exp.supplement.deltaVolume, `seed ${seed} ${exp.key} sup deltaVolume`);
        assert.equal(sup.deltaRebate, exp.supplement.deltaRebate, `seed ${seed} ${exp.key} sup deltaRebate`);
      } else {
        assert.equal(p.supplements.length, 0, `seed ${seed} ${exp.key} no supplement`);
      }
    }
  }
});
