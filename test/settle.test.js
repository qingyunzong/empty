'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { replay, recomputeReference, SettleError } = require('../lib');
const { main: cliMain } = require('../cli');

const CLI = path.join(__dirname, '..', 'cli.js');

function runCli(input, output) {
  const errors = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    const code = cliMain(['node', 'cli.js', input, output]);
    return { code, stderr: errors.join('') };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function rule(id, extra) {
  return Object.assign({ type: 'rule', id, scope: 'product', productId: 'p1', tiers: [{ upTo: null, rateBps: 100 }] }, extra);
}
function charge(id, extra) {
  return Object.assign({ type: 'charge', id, merchantId: 'm1', productId: 'p1', period: '2026-01', amount: 0 }, extra);
}

test('tier boundary 999 vs 1000 picks different tiers', () => {
  const events = [
    rule('r1', { tiers: [{ upTo: 999, rateBps: 100 }, { upTo: null, rateBps: 150 }] }),
    charge('c1', { merchantId: 'm-low', amount: 999 }),
    charge('c2', { merchantId: 'm-high', amount: 1000 }),
  ];
  const out = replay(events);
  const low = out.periods.find((p) => p.merchantId === 'm-low');
  const high = out.periods.find((p) => p.merchantId === 'm-high');
  assert.equal(low.volume, 999);
  assert.equal(low.rateBps, 100);
  assert.equal(low.rebate, Math.floor(999 * 100 / 10000));
  assert.equal(high.volume, 1000);
  assert.equal(high.rateBps, 150);
  assert.equal(high.rebate, Math.floor(1000 * 150 / 10000));
  assert.notEqual(low.rateBps, high.rateBps);
});

test('post-snapshot correction only enters supplement, snapshot hash unchanged', () => {
  const events = [
    rule('r1', { tiers: [{ upTo: null, rateBps: 1000 }] }),
    charge('c1', { amount: 1000 }),
    { type: 'snapshot', id: 'snap1', merchantId: 'm1', period: '2026-01' },
    { type: 'correct', id: 'x1', linksTo: 'c1', amount: 400 },
    charge('c2', { amount: 100 }),
  ];
  const out = replay(events);
  const period = out.periods[0];

  assert.equal(period.snapshot.id, 'snap1');
  assert.equal(period.snapshot.volume, 1000);
  assert.equal(period.snapshot.rebate, 100);
  assert.equal(period.rebate, 100, 'settled rebate stays at snapshot value');

  assert.equal(period.supplements.length, 1);
  const supp = period.supplements[0];
  assert.equal(supp.batchId, 'SUPP-snap1');
  assert.equal(supp.baseHash, period.snapshot.hash);
  assert.deepEqual(supp.eventIds, ['x1', 'c2']);
  assert.equal(supp.volume, 500);
  assert.equal(supp.rebate, 50);
  assert.equal(supp.deltaVolume, -500);
  assert.equal(supp.deltaRebate, -50);
  assert.equal(period.totalRebate, 50);

  const adj = period.adjustments.find((a) => a.chargeId === 'c1');
  assert.equal(adj.originalAmount, 1000);
  assert.equal(adj.effectiveAmount, 400);
  assert.deepEqual(adj.chain, [{ id: 'x1', amount: 400, delta: -600 }]);

  // Replaying only the pre-snapshot prefix must reproduce the identical hash,
  // proving post-snapshot events never touched the original snapshot.
  const prefix = replay(events.slice(0, 3));
  assert.equal(prefix.periods[0].snapshot.hash, period.snapshot.hash);
});

test('parallel rules tie-break by rate asc then ruleId; merchant rule overrides', () => {
  const base = [
    rule('r-b', { productId: 'p1', tiers: [{ upTo: null, rateBps: 200 }] }),
    rule('r-a', { productId: 'p2', tiers: [{ upTo: null, rateBps: 200 }] }),
    charge('c1', { productId: 'p1', amount: 100 }),
    charge('c2', { productId: 'p2', amount: 100 }),
  ];
  // equal rates -> lower ruleId wins
  assert.equal(replay(base).periods[0].ruleId, 'r-a');

  // lower rate wins regardless of ruleId
  const byRate = [
    rule('r-b', { productId: 'p1', tiers: [{ upTo: null, rateBps: 300 }] }),
    rule('r-a', { productId: 'p2', tiers: [{ upTo: null, rateBps: 200 }] }),
    charge('c1', { productId: 'p1', amount: 100 }),
    charge('c2', { productId: 'p2', amount: 100 }),
  ];
  assert.equal(replay(byRate).periods[0].ruleId, 'r-a');

  // merchant-scope rule overrides product-scope rules
  const withMerchant = base.concat([
    { type: 'rule', id: 'r-m', scope: 'merchant', merchantId: 'm1', tiers: [{ upTo: null, rateBps: 900 }] },
  ]);
  const out = replay(withMerchant);
  assert.equal(out.periods[0].ruleId, 'r-m');
  assert.equal(out.periods[0].rateBps, 900);

  // most recently defined merchant rule wins among overrides
  const overridden = withMerchant.concat([
    { type: 'rule', id: 'r-m2', scope: 'merchant', merchantId: 'm1', tiers: [{ upTo: null, rateBps: 50 }] },
  ]);
  assert.equal(replay(overridden).periods[0].ruleId, 'r-m2');
});

test('E_LINK on unknown or non-charge linksTo', () => {
  assert.throws(
    () => replay([{ type: 'correct', id: 'x1', linksTo: 'nope', amount: 1 }]),
    (err) => err instanceof SettleError && err.code === 'E_LINK',
  );
  assert.throws(
    () => replay([
      rule('r1'),
      { type: 'correct', id: 'x1', linksTo: 'r1', amount: 1 },
    ]),
    (err) => err.code === 'E_LINK',
  );
  // forward reference is also a link error
  assert.throws(
    () => replay([
      { type: 'correct', id: 'x1', linksTo: 'c1', amount: 1 },
      charge('c1', { amount: 5 }),
    ]),
    (err) => err.code === 'E_LINK',
  );
});

test('E_SNAPSHOT on duplicate snapshot for same merchant+period', () => {
  const events = [
    charge('c1', { amount: 10 }),
    { type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01' },
    { type: 'snapshot', id: 's2', merchantId: 'm1', period: '2026-01' },
  ];
  assert.throws(() => replay(events), (err) => err.code === 'E_SNAPSHOT');
  // same merchant, different period is fine
  const ok = replay([
    charge('c1', { amount: 10 }),
    { type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01' },
    { type: 'snapshot', id: 's2', merchantId: 'm1', period: '2026-02' },
  ]);
  assert.equal(ok.periods.length, 2);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genEvents(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const merchants = ['m0', 'm1', 'm2'];
  const products = ['p0', 'p1'];
  const periodNames = ['2026-01', '2026-02'];
  const n = 1 + Math.floor(rnd() * 200);
  const events = [];
  let seq = 0;
  const nextId = (prefix) => `${prefix}${seq++}`;
  const chargeIds = [];
  const snapshotted = new Set();
  const mkTiers = () => {
    const count = 1 + Math.floor(rnd() * 3);
    const tiers = [];
    let bound = 0;
    for (let i = 0; i < count; i++) {
      const last = i === count - 1;
      const upTo = last ? null : bound + Math.floor(rnd() * 2000);
      if (upTo !== null) bound = upTo + 1;
      tiers.push({ upTo, rateBps: Math.floor(rnd() * 500) });
    }
    return tiers;
  };
  events.push({ type: 'rule', id: nextId('r'), scope: 'product', productId: 'p0', tiers: mkTiers() });
  events.push({ type: 'rule', id: nextId('r'), scope: 'product', productId: 'p1', tiers: mkTiers() });
  while (events.length < n) {
    const roll = rnd();
    if (roll < 0.5 || chargeIds.length === 0) {
      const ev = {
        type: 'charge',
        id: nextId('c'),
        merchantId: pick(merchants),
        productId: pick(products),
        period: pick(periodNames),
        amount: Math.floor(rnd() * 2000),
      };
      events.push(ev);
      chargeIds.push(ev.id);
    } else if (roll < 0.65) {
      events.push({ type: 'correct', id: nextId('x'), linksTo: pick(chargeIds), amount: Math.floor(rnd() * 2000) });
    } else if (roll < 0.8) {
      const scope = rnd() < 0.5 ? 'product' : 'merchant';
      const ev = { type: 'rule', id: nextId('r'), scope, tiers: mkTiers() };
      if (scope === 'product') ev.productId = pick(products);
      else ev.merchantId = pick(merchants);
      if (rnd() < 0.3) ev.period = pick(periodNames);
      events.push(ev);
    } else {
      const m = pick(merchants);
      const p = pick(periodNames);
      const key = `${m}|${p}`;
      if (snapshotted.has(key)) continue;
      snapshotted.add(key);
      events.push({ type: 'snapshot', id: nextId('s'), merchantId: m, period: p });
    }
  }
  return events;
}

test('random streams (n<=200) match naive full recompute', () => {
  for (let seed = 0; seed < 60; seed++) {
    const events = genEvents(seed);
    assert.ok(events.length <= 200);
    const incremental = replay(events);
    const reference = recomputeReference(events);
    assert.deepEqual(incremental, reference, `seed ${seed} mismatch`);
  }
});

test('CLI writes settle.json and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'settle.json');
  const events = [
    rule('r1', { tiers: [{ upTo: 999, rateBps: 100 }, { upTo: null, rateBps: 150 }] }),
    charge('c1', { amount: 1000 }),
    { type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01' },
    { type: 'correct', id: 'x1', linksTo: 'c1', amount: 900 },
  ];
  fs.writeFileSync(input, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const run = runCli(input, output);
  assert.equal(run.code, 0);
  const settle = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(settle.version, 1);
  assert.equal(settle.periods.length, 1);
  assert.equal(settle.periods[0].snapshot.rebate, 15);
  assert.equal(settle.periods[0].supplements[0].deltaRebate, -6);
});

test('CLI exits 1 on E_LINK and E_SNAPSHOT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const output = path.join(dir, 'settle.json');

  const linkInput = path.join(dir, 'link.jsonl');
  fs.writeFileSync(linkInput, JSON.stringify({ type: 'correct', id: 'x1', linksTo: 'nope', amount: 1 }) + '\n');
  const linkRun = runCli(linkInput, output);
  assert.equal(linkRun.code, 1);
  assert.match(linkRun.stderr, /E_LINK/);

  const snapInput = path.join(dir, 'snap.jsonl');
  const snapEvents = [
    charge('c1', { amount: 10 }),
    { type: 'snapshot', id: 's1', merchantId: 'm1', period: '2026-01' },
    { type: 'snapshot', id: 's2', merchantId: 'm1', period: '2026-01' },
  ];
  fs.writeFileSync(snapInput, snapEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const snapRun = runCli(snapInput, output);
  assert.equal(snapRun.code, 1);
  assert.match(snapRun.stderr, /E_SNAPSHOT/);
});
