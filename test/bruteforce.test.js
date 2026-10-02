import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NettingEngine } from '../src/engine.js';
import { toUnits, mulUnits, SCALE } from '../src/decimal.js';

// Reference implementation: enumerate every unordered pair and offset the
// bilateral minimum. Net positions per party are invariant under any valid
// netting (cycle netting included), so the engine must match this exactly;
// its settlement volume must never exceed the bilateral-only reference.

const RATES = new Map([
  ['USD', SCALE],
  ['EUR', toUnits('1.20')],
  ['GBP', toUnits('1.25')],
]);

function bruteForceBilateral(trades) {
  const edges = new Map(); // 'from>to' -> units
  const parties = new Set();
  for (const t of trades) {
    const amt = mulUnits(toUnits(t.amount), RATES.get(t.currency));
    parties.add(t.from).add(t.to);
    const k = t.from + '>' + t.to;
    edges.set(k, (edges.get(k) ?? 0n) + amt);
  }
  // Enumerate all bilateral offsets.
  const seen = new Set();
  for (const k of [...edges.keys()]) {
    const [a, b] = k.split('>');
    const rk = b + '>' + a;
    if (seen.has(k) || seen.has(rk)) continue;
    seen.add(k).add(rk);
    const ab = edges.get(k) ?? 0n;
    const ba = edges.get(rk) ?? 0n;
    const off = ab < ba ? ab : ba;
    edges.set(k, ab - off);
    edges.set(rk, ba - off);
  }
  const net = new Map([...parties].map((p) => [p, 0n]));
  let volume = 0n;
  for (const [k, v] of edges) {
    if (v === 0n) continue;
    const [a, b] = k.split('>');
    net.set(a, net.get(a) - v);
    net.set(b, net.get(b) + v);
    volume += v;
  }
  return { net, volume };
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomTrades(rand) {
  const n = 2 + Math.floor(rand() * 7); // 2..8 parties
  const parties = Array.from({ length: n }, (_, i) => 'P' + i);
  const m = 1 + Math.floor(rand() * 12);
  const currencies = ['USD', 'EUR', 'GBP'];
  const trades = [];
  for (let i = 0; i < m; i += 1) {
    const from = parties[Math.floor(rand() * n)];
    let to = parties[Math.floor(rand() * n)];
    if (to === from) to = parties[(parties.indexOf(to) + 1) % n];
    trades.push({
      id: 't' + i,
      from,
      to,
      currency: currencies[Math.floor(rand() * currencies.length)],
      amount: String(1 + Math.floor(rand() * 500)),
    });
  }
  return trades;
}

test('n<=8: engine net positions match enumeration of all bilateral offsets', () => {
  const ratesDoc = {
    base: 'USD',
    versions: [{ version: 1, rates: { EUR: '1.20', GBP: '1.25' } }],
  };
  const ITERATIONS = 200;
  for (let seed = 1; seed <= ITERATIONS; seed += 1) {
    const rand = lcg(seed);
    const trades = randomTrades(rand);
    const engine = new NettingEngine({ rates: ratesDoc }); // unlimited capacity
    engine.addTrades(trades);
    const r = engine.settle();

    const ref = bruteForceBilateral(trades);

    // Net positions identical to the bilateral-offset enumeration.
    for (const p of r.netPositions) {
      const expected = ref.net.get(p.party) ?? 0n;
      assert.equal(
        toUnits(p.net),
        expected,
        `seed ${seed}: net position of ${p.party} differs (trades: ${JSON.stringify(trades)})`,
      );
    }
    // Cycle netting never increases settlement volume vs bilateral-only.
    assert.ok(
      toUnits(r.window.used) <= ref.volume,
      `seed ${seed}: engine volume exceeds bilateral reference`,
    );
  }
});

test('cycle netting strictly reduces volume vs bilateral-only enumeration', () => {
  const ratesDoc = { base: 'USD', versions: [{ version: 1, rates: {} }] };
  const trades = [
    { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '50' },
    { id: 't2', from: 'B', to: 'C', currency: 'USD', amount: '50' },
    { id: 't3', from: 'C', to: 'A', currency: 'USD', amount: '50' },
  ];
  const engine = new NettingEngine({ rates: ratesDoc });
  engine.addTrades(trades);
  const r = engine.settle();
  const ref = bruteForceBilateral(trades);
  assert.equal(ref.volume, 150n * SCALE); // no mutual pairs -> nothing offsets
  assert.equal(r.window.used, '0'); // cycle fully netted
});
