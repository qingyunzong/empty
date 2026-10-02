import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../src/model.js';
import { optimize, compareScore, score, EXACT_LIMIT } from '../src/schedule.js';

const wrap = (arr) => arr.map((obj) => ({ obj, at: 'test' }));

// Independent brute-force reference: own decoder, own enumeration.
function bruteForce(ds) {
  const ids = [...ds.orders.keys()].sort();
  let best = null;
  const permute = (prefix, rest) => {
    if (rest.length === 0) {
      const machineFree = {}, lastMold = {}, moldFree = {}, opFree = {};
      let makespan = 0, totalSetup = 0;
      for (const id of prefix) {
        const o = ds.orders.get(id);
        const m = ds.molds.get(o.mold).machine;
        const prev = lastMold[m] ?? null;
        const s = prev == null || prev === o.mold ? 0
          : ds.setups.get(`${prev}->${o.mold}`) ?? ds.setups.get(`*->${o.mold}`)
          ?? ds.setups.get(`${prev}->*`) ?? ds.setups.get('*->*') ?? 0;
        const dur = o.qty / ds.machines.get(m).rate;
        const start = Math.max(machineFree[m] ?? 0, moldFree[o.mold] ?? 0, opFree[o.operator] ?? 0);
        const end = start + s + dur;
        machineFree[m] = moldFree[o.mold] = opFree[o.operator] = end;
        lastMold[m] = o.mold;
        makespan = Math.max(makespan, end);
        totalSetup += s;
      }
      const cand = { seq: prefix, makespan, totalSetup };
      if (!best
        || cand.makespan < best.makespan - 1e-9
        || (Math.abs(cand.makespan - best.makespan) <= 1e-9 && cand.totalSetup < best.totalSetup - 1e-9)
        || (Math.abs(cand.makespan - best.makespan) <= 1e-9 && Math.abs(cand.totalSetup - best.totalSetup) <= 1e-9
            && cand.seq.join('') < best.seq.join(''))) best = cand;
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      permute([...prefix, rest[i]], rest.slice(0, i).concat(rest.slice(i + 1)));
    }
  };
  permute([], ids);
  return best;
}

function randomDataset(rng, nOrders) {
  const machines = [
    { id: 'K1', rate: 4 + Math.floor(rng() * 8) },
    { id: 'K2', rate: 4 + Math.floor(rng() * 8) },
  ];
  const molds = [
    { id: 'M1', machine: 'K1' }, { id: 'M2', machine: 'K1' },
    { id: 'M3', machine: 'K2' }, { id: 'M4', machine: 'K2' },
  ];
  const operators = [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }];
  const setups = [];
  for (const a of molds) for (const b of molds) {
    if (a.machine === b.machine && a.id !== b.id) {
      setups.push({ from: a.id, to: b.id, minutes: Math.floor(rng() * 6) });
    }
  }
  const orders = [];
  for (let i = 0; i < nOrders; i++) {
    orders.push({
      id: 'O' + String(i + 1).padStart(2, '0'),
      mold: molds[Math.floor(rng() * molds.length)].id,
      operator: operators[Math.floor(rng() * operators.length)].id,
      qty: 10 + Math.floor(rng() * 90),
      due: 100000,
    });
  }
  return buildDataset({
    machines: wrap(machines), molds: wrap(molds), operators: wrap(operators),
    setups: wrap(setups), orders: wrap(orders),
  });
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acceptance 1: optimizer matches brute-force enumeration (well within 20 orders).
test('optimizer agrees with brute-force enumeration on 40 random cases (n<=7)', () => {
  for (let trial = 0; trial < 40; trial++) {
    const rng = mulberry32(1000 + trial);
    const ds = randomDataset(rng, 3 + Math.floor(rng() * 5));
    const opt = optimize(ds);
    const brute = bruteForce(ds);
    assert.ok(Math.abs(opt.makespan - brute.makespan) < 1e-6, `trial ${trial} makespan ${opt.makespan} != ${brute.makespan}`);
    assert.ok(Math.abs(opt.totalSetup - brute.totalSetup) < 1e-6, `trial ${trial} setups`);
    assert.deepEqual(opt.seq, brute.seq, `trial ${trial} sequence`);
  }
});

test('tie-break: earliest makespan, then fewest changeovers, then lexicographic', () => {
  const ds = buildDataset({
    machines: wrap([{ id: 'K1', rate: 10 }]),
    molds: wrap([{ id: 'M1', machine: 'K1' }, { id: 'M2', machine: 'K1' }]),
    operators: wrap([{ id: 'P1' }, { id: 'P2' }]),
    setups: wrap([{ from: 'M1', to: 'M2', minutes: 5 }, { from: 'M2', to: 'M1', minutes: 1 }]),
    orders: wrap([
      { id: 'A', mold: 'M1', operator: 'P1', qty: 10, due: 1000 },
      { id: 'B', mold: 'M2', operator: 'P2', qty: 10, due: 1000 },
    ]),
  });
  const opt = optimize(ds);
  // both orders same makespan either way; M2->M1 setup (1) beats M1->M2 (5)
  assert.deepEqual(opt.seq, ['B', 'A']);
  assert.equal(opt.totalSetup, 1);
  // lexicographic: identical setups -> ['A','B']
  const ds2 = buildDataset({
    machines: wrap([{ id: 'K1', rate: 10 }]),
    molds: wrap([{ id: 'M1', machine: 'K1' }, { id: 'M2', machine: 'K1' }]),
    operators: wrap([{ id: 'P1' }, { id: 'P2' }]),
    setups: wrap([{ from: 'M1', to: 'M2', minutes: 3 }, { from: 'M2', to: 'M1', minutes: 3 }]),
    orders: wrap([
      { id: 'A', mold: 'M1', operator: 'P1', qty: 10, due: 1000 },
      { id: 'B', mold: 'M2', operator: 'P2', qty: 10, due: 1000 },
    ]),
  });
  assert.deepEqual(optimize(ds2).seq, ['A', 'B']);
});

test('resource mutex: machine, mold and operator never overlap', () => {
  const rng = mulberry32(42);
  const ds = randomDataset(rng, 8);
  const { jobs } = score(ds, optimize(ds).seq);
  for (const res of ['machine', 'mold', 'operator']) {
    for (let i = 0; i < jobs.length; i++) for (let j = i + 1; j < jobs.length; j++) {
      if (jobs[i][res] !== jobs[j][res]) continue;
      const overlap = jobs[i].start < jobs[j].end - 1e-9 && jobs[j].start < jobs[i].end - 1e-9;
      assert.ok(!overlap, `${res} overlap between ${jobs[i].id} and ${jobs[j].id}`);
    }
  }
});

test(`exact search limit is ${EXACT_LIMIT}; greedy path is deterministic`, () => {
  const rng = mulberry32(7);
  const ds = randomDataset(rng, 12);
  const a = optimize(ds), b = optimize(ds);
  assert.deepEqual(a.seq, b.seq);
});
