import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistories, foldOrder, enumerateTopoOrders } from '../src/index.js';
import { mulberry32 } from './helpers.js';

const ENUM_CONFIG = {
  species: { S1: { morph: 'm' }, S2: { morph: 'm' }, S3: { morph: 'm' } },
  plots: { P1: { area: 100, morphs: ['m'] }, P2: { area: 100, morphs: ['m'] } },
  tiers: [0, 1, 2, 3],
  tierWeights: { 0: 0, 1: 1, 2: 2, 3: 3 },
  capacityPerArea: 100,
};

// Random small histories (total ops <= 8): set_count, at most one
// morph_species (to a species that is never set directly, so conservation
// cannot fire), and optionally one rendezvous sync pair.
function generate(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const devices = ['D1', 'D2'];
  const perDevice = { D1: [], D2: [] };
  let total = 0;
  const target = 2 + Math.floor(rnd() * 7); // 2..8 ops
  let morphUsed = false;
  while (total < target) {
    const dev = pick(devices);
    const kind = rnd();
    if (kind < 0.7 || morphUsed) {
      perDevice[dev].push({
        op: 'set_count',
        plot: pick(['P1', 'P2']),
        species: pick(['S1', 'S2']),
        tier: pick([1, 2]),
      });
    } else {
      perDevice[dev].push({ op: 'morph_species', from: 'S1', to: 'S3' });
      morphUsed = true;
    }
    total++;
  }
  if (rnd() < 0.5 && perDevice.D1.length && perDevice.D2.length) {
    const session = `s${seed}`;
    const i = Math.floor(rnd() * (perDevice.D1.length + 1));
    const j = Math.floor(rnd() * (perDevice.D2.length + 1));
    perDevice.D1.splice(i, 0, { op: 'sync', session });
    perDevice.D2.splice(j, 0, { op: 'sync', session });
  }
  return devices.map((dev) => ({
    name: dev,
    text: perDevice[dev].map((o, i) => JSON.stringify({ device: dev, time: i + 1, ...o })).join('\n'),
  }));
}

test('acceptance 4: n<=8 merge verdicts agree with exhaustive topological enumeration', () => {
  let checked = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const inputs = generate(seed);
    if (inputs.some((f) => !f.text)) continue;
    const r = mergeHistories(inputs, ENUM_CONFIG, { budget: 10_000_000 });
    assert.notEqual(r.verdict, 'PENDING', `seed ${seed}`);
    if (r.verdict === 'CONFLICT' && r.reason === 'CAUSAL_CYCLE') {
      for (let i = 0; i < r.cycle.length; i++)
        assert.ok(r.graph.adj.get(r.cycle[i]).has(r.cycle[(i + 1) % r.cycle.length]), `seed ${seed} cycle edge`);
      checked++;
      continue;
    }
    const orders = enumerateTopoOrders(r.graph.nodes, r.graph.adj);
    const matrices = new Set(
      orders.map((o) => JSON.stringify(foldOrder(o.map((id) => r.graph.byId.get(id)), r.effective))),
    );
    if (r.verdict === 'CONFLICT') {
      assert.equal(r.reason, 'WRITE_CONFLICT', `seed ${seed}`);
      assert.ok(matrices.size > 1, `seed ${seed}: conflict but all serializations agree`);
    } else {
      assert.ok(
        matrices.size <= 1 && (matrices.size === 0 || [...matrices][0] === JSON.stringify(r.matrix)),
        `seed ${seed}: merge matrix disagrees with some legal serialization`,
      );
      if (r.verdict === 'LINEARIZABLE_MODEL') assert.equal(orders.length, 1, `seed ${seed}`);
    }
    checked++;
  }
  assert.ok(checked >= 300, `too few cases exercised: ${checked}`);
});
