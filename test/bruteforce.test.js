import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeeEngine } from '../src/engine.js';

// Deterministic PRNG so failures reproduce.
function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference implementation: recompute every account from scratch
// by brute force over all trades and all packages. Uses the engine's rounding
// convention (integer per-million rates) since that convention is part of the
// fee specification.
function bruteForce(packages, trades) {
  const turnovers = new Map();
  for (const trade of trades.values()) {
    turnovers.set(trade.account, (turnovers.get(trade.account) ?? 0) + trade.amountCents);
  }
  const result = new Map();
  for (const [account, turnoverCents] of turnovers) {
    let best = null;
    const tied = [];
    for (const pkg of packages.values()) {
      let fee = 0;
      let lower = 0;
      let hit = null;
      pkg.tiers.forEach((tier, i) => {
        const up = tier.upTo === null || tier.upTo === undefined
          ? Infinity
          : Math.round(tier.upTo * 100);
        const amount = Math.max(0, Math.min(turnoverCents, up) - lower);
        if (amount > 0) hit = i;
        fee += amount * Math.round(tier.rate * 1_000_000);
        lower = up;
      });
      let gross = Math.round(fee / 1_000_000);
      if (turnoverCents > 0) gross = Math.max(gross, Math.round((pkg.minFee ?? 0) * 100));
      let rebate = 0;
      for (const r of pkg.rebates ?? []) {
        if (turnoverCents >= Math.round((r.minTurnover ?? 0) * 100)) {
          rebate += r.amount !== undefined
            ? Math.round(r.amount * 100)
            : Math.round((gross * Math.round((r.percent / 100) * 1_000_000)) / 1_000_000);
        }
      }
      const feeCents = Math.max(0, gross - rebate);
      const hitTier = turnoverCents > 0 ? hit : null;
      if (best === null || feeCents < best.feeCents) {
        best = { feeCents, hitTier, chosen: pkg.id };
        tied.length = 0;
        tied.push(pkg.id);
      } else if (feeCents === best.feeCents) {
        tied.push(pkg.id);
      }
    }
    if (best === null) {
      result.set(account, { feeCents: 0, hitTier: null, chosen: null, tied: [] });
    } else {
      tied.sort();
      result.set(account, { ...best, chosen: tied[0], tied });
    }
  }
  return result;
}

const PACKAGE_V1 = {
  type: 'package',
  id: 'alpha',
  version: 1,
  tiers: [
    { upTo: 50000, rate: 0.0012 },
    { upTo: 150000, rate: 0.001 },
    { upTo: null, rate: 0.0008 },
  ],
  minFee: 3,
  rebates: [{ minTurnover: 100000, percent: 5 }],
};

const PACKAGE_V2 = {
  ...PACKAGE_V1,
  version: 2,
  tiers: [
    { upTo: 80000, rate: 0.0011 },
    { upTo: null, rate: 0.0009 },
  ],
  minFee: 4,
};

const PACKAGE_B = {
  type: 'package',
  id: 'beta',
  version: 1,
  tiers: [
    { upTo: 100000, rate: 0.0015 },
    { upTo: null, rate: 0.0006 },
  ],
  minFee: 5,
  rebates: [{ minTurnover: 200000, amount: 8 }],
};

function randomScenario(seed, steps) {
  const rand = mulberry32(seed);
  const events = [
    PACKAGE_V1,
    PACKAGE_B,
    { type: 'trade', id: 'seed-0', account: 'A', amount: 40000 },
    { type: 'trade', id: 'seed-1', account: 'B', amount: 90000 },
    { type: 'trade', id: 'seed-2', account: 'C', amount: 160000 },
    { type: 'trade', id: 'seed-3', account: 'D', amount: 5000 },
  ];
  // Model mirrors the engine so we only emit valid events.
  const model = {
    packages: new Map([['alpha', PACKAGE_V1], ['beta', PACKAGE_B]]),
    trades: new Map(),
    turnovers: new Map([['A', 4000000], ['B', 9000000], ['C', 16000000], ['D', 500000]]),
  };
  for (const ev of events.slice(2)) model.trades.set(ev.id, { account: ev.account, amountCents: ev.amount * 100 });
  const accounts = ['A', 'B', 'C', 'D'];
  let seq = 0;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const dollars = (max) => 1 + Math.floor(rand() * max);

  for (let i = 0; i < steps; i += 1) {
    const roll = rand();
    const liveTrades = [...model.trades.entries()];
    if (roll < 0.35 || liveTrades.length === 0) {
      const account = pick(accounts);
      const amount = dollars(180000);
      const id = `t${seq++}`;
      events.push({ type: 'trade', id, account, amount });
      model.trades.set(id, { account, amountCents: amount * 100 });
      model.turnovers.set(account, (model.turnovers.get(account) ?? 0) + amount * 100);
    } else if (roll < 0.55) {
      const [id, trade] = pick(liveTrades);
      const amount = dollars(180000);
      const turnover = model.turnovers.get(trade.account);
      if (turnover - trade.amountCents + amount * 100 < 0) continue;
      events.push({ type: 'amend', id, amount });
      model.trades.set(id, { account: trade.account, amountCents: amount * 100 });
      model.turnovers.set(trade.account, turnover - trade.amountCents + amount * 100);
    } else if (roll < 0.7) {
      const [id, trade] = pick(liveTrades);
      const turnover = model.turnovers.get(trade.account);
      if (turnover - trade.amountCents < 0) continue;
      events.push({ type: 'cancel', id });
      model.trades.delete(id);
      model.turnovers.set(trade.account, turnover - trade.amountCents);
    } else if (roll < 0.8) {
      const positive = liveTrades.filter(([, t]) => t.amountCents > 0);
      if (positive.length === 0) continue;
      const [, trade] = pick(positive);
      const maxPart = Math.min(trade.amountCents, model.turnovers.get(trade.account));
      if (maxPart < 100) continue;
      const part = (1 + Math.floor(rand() * (maxPart / 100 - 1))) * 100;
      const id = `r${seq++}`;
      events.push({ type: 'reversal', id, ref: pick([...model.trades.entries()]
        .filter(([, t]) => t.account === trade.account && t.amountCents > 0)
        .map(([tid]) => tid)), amount: -part / 100 });
      // recompute ref validity: reversal must reference an active trade; the
      // picked ref is active by construction.
      model.trades.set(id, { account: trade.account, amountCents: -part });
      model.turnovers.set(trade.account, model.turnovers.get(trade.account) - part);
    } else if (roll < 0.9) {
      const versioned = rand() < 0.5 ? PACKAGE_V2 : PACKAGE_V1;
      events.push(versioned);
      model.packages.set('alpha', versioned);
    } else {
      const ids = [...model.packages.keys()];
      if (ids.length === 0) {
        events.push(PACKAGE_B);
        model.packages.set('beta', PACKAGE_B);
      } else {
        const id = pick(ids);
        events.push({ type: 'deactivate', packageId: id });
        model.packages.delete(id);
      }
    }
  }
  return { events, model };
}

// Fold one event into the reference model (mirrors the engine's semantics).
function applyToModel(model, event) {
  switch (event.type) {
    case 'package':
      model.packages.set(event.id, event);
      break;
    case 'deactivate':
      model.packages.delete(event.packageId);
      break;
    case 'trade':
      model.trades.set(event.id, { account: event.account, amountCents: Math.round(event.amount * 100) });
      break;
    case 'amend': {
      const trade = model.trades.get(event.id);
      model.trades.set(event.id, { account: trade.account, amountCents: Math.round(event.amount * 100) });
      break;
    }
    case 'cancel':
      model.trades.delete(event.id);
      break;
    case 'reversal': {
      const ref = model.trades.get(event.ref);
      model.trades.set(event.id, { account: ref.account, amountCents: Math.round(event.amount * 100) });
      break;
    }
    default:
      throw new Error(`unknown event ${event.type}`);
  }
}

test('incremental engine matches brute-force recomputation on random event streams', () => {
  for (const seed of [7, 42, 1337]) {
    const { events } = randomScenario(seed, 250);
    const engine = new FeeEngine();
    const model = { packages: new Map(), trades: new Map() };
    for (const [index, event] of events.entries()) {
      engine.applyEvent(event);
      applyToModel(model, event);
      const expected = bruteForce(model.packages, model.trades);
      for (const [account, want] of expected) {
        const got = engine.accountView(account);
        assert.ok(got, `seed ${seed} event ${index}: missing account ${account}`);
        assert.equal(got.feeCents, want.feeCents, `seed ${seed} event ${index} ${account} fee`);
        assert.equal(got.hitTier, want.hitTier, `seed ${seed} event ${index} ${account} tier`);
        assert.equal(got.package, want.chosen, `seed ${seed} event ${index} ${account} package`);
        assert.deepEqual(got.tied, want.tied, `seed ${seed} event ${index} ${account} tied`);
      }
    }
  }
});

test('certificate is deterministic across replays and restores', () => {
  const { events } = randomScenario(99, 120);
  const a = new FeeEngine();
  const b = new FeeEngine();
  for (const event of events) {
    a.applyEvent(event);
    b.applyEvent(event);
  }
  assert.equal(a.certificate().digest, b.certificate().digest);
  const restored = FeeEngine.restore(a.snapshot());
  assert.equal(restored.certificate().digest, a.certificate().digest);
});
