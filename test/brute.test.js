import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { RULE_VERSIONS, selectPackage } from '../src/rules.js';

const DAY = '2026-10-03';

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

function naiveTurnovers(events) {
  const trades = new Map();
  const turn = new Map();
  const add = (acct, d) => turn.set(acct, (turn.get(acct) ?? 0) + d);
  for (const ev of events) {
    if (ev.type === 'trade') {
      if (ev.amount > 0) {
        trades.set(ev.id, { acct: ev.account, remaining: ev.amount });
        add(ev.account, ev.amount);
      } else {
        const o = trades.get(ev.of);
        o.remaining += ev.amount;
        add(ev.account, ev.amount);
        trades.set(ev.id, { acct: ev.account, remaining: 0 });
      }
    } else if (ev.type === 'cancel') {
      const t = trades.get(ev.id);
      add(t.acct, -t.remaining);
      t.remaining = 0;
    } else if (ev.type === 'amend') {
      const t = trades.get(ev.id);
      add(t.acct, -t.remaining);
      t.remaining = 0;
      trades.set(ev.newId, { acct: t.acct, remaining: ev.amount });
      add(t.acct, ev.amount);
    }
  }
  return turn;
}

function eligiblePacks(version, allowlist) {
  const all = RULE_VERSIONS[version].packages;
  const filtered = allowlist ? all.filter((p) => allowlist.includes(p.id)) : all;
  return filtered.length ? filtered : all;
}

function generate(seed, count) {
  const rng = mulberry32(seed);
  const accounts = ['A', 'B', 'C'];
  const allowlists = { A: ['P-STD'], B: ['P-STD', 'P-PRO'], C: null };
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const amounts = [10_000, 50_000, 120_000, 450_000, 900_000, 1_500_000, 3_000_000];
  const events = [];
  const remaining = new Map();
  let n = 0;
  let version = 'v1';
  for (const acct of accounts) events.push({ type: 'account', account: acct, packages: allowlists[acct] ?? undefined });
  while (n < count) {
    const acct = pick(accounts);
    const live = [...remaining.entries()].filter(([, v]) => v.acct === acct && v.left > 0).map(([k]) => k);
    const roll = rng();
    if (roll < 0.5 || live.length === 0) {
      const id = `t${n}`;
      const amount = pick(amounts) + Math.floor(rng() * 10_000);
      events.push({ type: 'trade', id, account: acct, amount });
      remaining.set(id, { acct, left: amount });
    } else if (roll < 0.65) {
      const id = pick(live);
      events.push({ type: 'cancel', id });
      remaining.get(id).left = 0;
    } else if (roll < 0.8) {
      const id = pick(live);
      const newId = `t${n}m`;
      const amount = pick(amounts) + Math.floor(rng() * 10_000);
      events.push({ type: 'amend', id, newId, amount });
      remaining.get(id).left = 0;
      remaining.set(newId, { acct, left: amount });
    } else if (roll < 0.95) {
      const id = pick(live);
      const mag = 1 + Math.floor(rng() * remaining.get(id).left);
      events.push({ type: 'trade', id: `t${n}r`, account: acct, amount: -mag, of: id });
      remaining.get(id).left -= mag;
    } else {
      version = version === 'v1' ? 'v2' : 'v1';
      events.push({ type: 'rules', version });
    }
    n += 1;
  }
  return { events, allowlists, version };
}

for (const seed of [1, 7, 42, 1337]) {
  test(`incremental engine matches brute-force recompute (seed ${seed})`, () => {
    const { events, allowlists, version } = generate(seed, 300);
    const engine = new Engine({ day: DAY });
    for (const ev of events) engine.apply(ev);
    const turn = naiveTurnovers(events);
    for (const [acct, a] of engine.accounts) {
      const expected = turn.get(acct) ?? 0;
      assert.equal(a.turnover, expected, `${acct} turnover`);
      if (!a.breakdown) {
        assert.equal(expected, 0, `${acct} untouched`);
        continue;
      }
      const expectedFee = selectPackage(eligiblePacks(version, allowlists[acct]), expected);
      assert.equal(a.selected, expectedFee.winner, `${acct} package`);
      assert.deepEqual(a.tied, expectedFee.tied, `${acct} tied`);
      const expectedNet = expectedFee.results.find((r) => r.packageId === expectedFee.winner).net;
      assert.equal(a.breakdown.net, expectedNet, `${acct} fee`);
    }
    assert.equal(turn.size, engine.accounts.size);
  });
}

test('replays of the same log produce identical certificates', () => {
  const { events } = generate(99, 200);
  const run = () => {
    const e = new Engine({ day: DAY });
    for (const ev of events) e.apply(ev);
    return e.eod().map((l) => l.certificate);
  };
  assert.deepEqual(run(), run());
});
