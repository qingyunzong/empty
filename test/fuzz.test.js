import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource, Fraction } from '../src/index.js';

// Acceptance 4: random lots + random action sequences, cross-checked against
// an independent FIFO reference implementation written from scratch here.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- independent exact rational arithmetic (bigint pairs) ---
const g0 = [0n, 1n];
const gcd = (a, b) => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};
const frac = (n, d = 1n) => {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d);
  return [n / g, d / g];
};
const fadd = (a, b) => frac(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const fsub = (a, b) => frac(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const fmul = (a, b) => frac(a[0] * b[0], a[1] * b[1]);
const fdiv = (a, b) => frac(a[0] * b[1], a[1] * b[0]);
const fcmp = (a, b) => {
  const l = a[0] * b[1];
  const r = b[0] * a[1];
  return l < r ? -1 : l > r ? 1 : 0;
};

// --- independent reference settlement model ---
function reference(lotsInput, ops) {
  const lots = lotsInput.lots.map((l, i) => ({
    id: l.id, sec: l.security, qty: frac(BigInt(l.qty)), acq: l.date, seq: i,
  }));
  let cash = frac(BigInt(lotsInput.cash ?? 0));
  const receivables = [];
  const records = new Map();
  const held = (sec) => lots.filter((l) => l.sec === sec && fcmp(l.qty, g0) > 0).sort((a, b) => a.seq - b.seq);

  for (const op of ops) {
    if (op.type === 'split') {
      const effects = [];
      for (const lot of held(op.sec).filter((l) => l.acq < op.ex)) {
        const newQ = fdiv(lot.qty, op.ratio);
        effects.push({ lotId: lot.id, granted: fsub(newQ, lot.qty) });
        lot.qty = newQ;
      }
      records.set(op.id, { op, effects, cashDelta: g0, status: 'applied' });
    } else if (op.type === 'dividend') {
      let delta = g0;
      for (const lot of held(op.sec).filter((l) => l.acq < op.ex)) delta = fadd(delta, fmul(lot.qty, op.cash));
      cash = fadd(cash, delta);
      records.set(op.id, { op, effects: [], cashDelta: delta, status: 'applied' });
    } else if (op.type === 'sell') {
      let rem = op.qty;
      for (const lot of held(op.sec)) {
        if (fcmp(rem, g0) <= 0) break;
        const take = fcmp(lot.qty, rem) <= 0 ? lot.qty : rem;
        lot.qty = fsub(lot.qty, take);
        rem = fsub(rem, take);
      }
      if (fcmp(rem, g0) > 0) throw new Error('reference oversell (generator bug)');
    } else if (op.type === 'reverse') {
      const rec = records.get(op.id);
      if (!rec || rec.status !== 'applied') throw new Error('reference bad reverse (generator bug)');
      if (rec.op.type === 'split') {
        for (const eff of rec.effects) {
          const lot = lots.find((l) => l.id === eff.lotId);
          const take = fcmp(lot.qty, eff.granted) >= 0 ? eff.granted : lot.qty;
          lot.qty = fsub(lot.qty, take);
          const short = fsub(eff.granted, take);
          if (fcmp(short, g0) > 0) receivables.push({ sec: rec.op.sec, qty: fsub(g0, short) });
        }
      }
      cash = fsub(cash, rec.cashDelta);
      rec.status = 'reversed';
    }
  }
  return { lots, cash, receivables, records };
}

const RATIOS = [
  [1n, 2n], [1n, 3n], [2n, 3n], [1n, 4n], [3n, 4n], [2n, 5n], [1n, 5n],
];
const SECS = ['AAA', 'BBB', 'CCC'];

function generate(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const lots = [];
  let lid = 0;
  for (const sec of SECS) {
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      lots.push({
        id: `L${++lid}`,
        security: sec,
        qty: String(10 + Math.floor(rnd() * 490)),
        date: `2023-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
      });
    }
  }
  const input = { cash: String(Math.floor(rnd() * 1000)), lots };

  const ops = [];
  const ref = { applied: [] };
  const refLots = lots.map((l, i) => ({ id: l.id, sec: l.security, qty: frac(BigInt(l.qty)), acq: l.date, seq: i }));
  const refRecords = new Map();
  const heldQty = (sec) => refLots.filter((l) => l.sec === sec).reduce((a, l) => fadd(a, l.qty), g0);
  const exdate = () => `2024-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;

  let aid = 0;
  const nOps = 25 + Math.floor(rnd() * 15);
  for (let i = 0; i < nOps; i++) {
    const r = rnd();
    if (r < 0.35) {
      const [n, d] = pick(RATIOS);
      const sec = pick(SECS);
      const op = { type: 'split', id: `A${++aid}`, sec, ratio: frac(n, d), ex: exdate() };
      ops.push(op);
      ref.applied.push(op.id);
      const effects = [];
      for (const lot of refLots) {
        if (lot.sec === sec && lot.acq < op.ex && fcmp(lot.qty, g0) > 0) {
          const newQ = fdiv(lot.qty, op.ratio);
          effects.push({ lotId: lot.id, granted: fsub(newQ, lot.qty) });
          lot.qty = newQ;
        }
      }
      refRecords.set(op.id, { op, effects });
    } else if (r < 0.55) {
      const sec = pick(SECS);
      const op = { type: 'dividend', id: `A${++aid}`, sec, cash: frac(BigInt(1 + Math.floor(rnd() * 20))), ex: exdate() };
      ops.push(op);
      ref.applied.push(op.id);
    } else if (r < 0.8) {
      const sec = pick(SECS);
      const total = heldQty(sec);
      if (fcmp(total, g0) <= 0) continue;
      const maxSell = total[0] / total[1];
      if (maxSell < 1n) continue;
      const q = 1n + BigInt(Math.floor(rnd() * Number(maxSell)));
      const qty = frac(q);
      ops.push({ type: 'sell', sec, qty, date: exdate() });
      let rem = qty;
      for (const lot of refLots.filter((l) => l.sec === sec).sort((a, b) => a.seq - b.seq)) {
        if (fcmp(rem, g0) <= 0) break;
        const take = fcmp(lot.qty, rem) <= 0 ? lot.qty : rem;
        lot.qty = fsub(lot.qty, take);
        rem = fsub(rem, take);
      }
    } else if (ref.applied.length > 0) {
      const id = pick(ref.applied);
      ref.applied.splice(ref.applied.indexOf(id), 1);
      ops.push({ type: 'reverse', id });
      const rec = refRecords.get(id);
      if (rec && rec.op.type === 'split') {
        for (const eff of rec.effects) {
          const lot = refLots.find((l) => l.id === eff.lotId);
          const take = fcmp(lot.qty, eff.granted) >= 0 ? eff.granted : lot.qty;
          lot.qty = fsub(lot.qty, take);
        }
      }
    }
  }
  return { input, ops };
}

function toSource(ops) {
  const lines = [];
  for (const op of ops) {
    if (op.type === 'split') {
      lines.push(`action ${op.id} { security ${op.sec} kind split ratio ${op.ratio[0]}/${op.ratio[1]} exdate ${op.ex} version 1 }`);
      lines.push(`apply ${op.id}`);
    } else if (op.type === 'dividend') {
      lines.push(`action ${op.id} { security ${op.sec} kind dividend cash $${op.cash[0]} exdate ${op.ex} version 1 }`);
      lines.push(`apply ${op.id}`);
    } else if (op.type === 'sell') {
      if (op.qty[1] !== 1n) throw new Error('sell qty must be integer');
      lines.push(`sell ${op.sec} ${op.qty[0]} on ${op.date}`);
    } else if (op.type === 'reverse') {
      lines.push(`reverse ${op.id}`);
    }
  }
  return lines.join('\n');
}

test('random lots and action sequences match independent FIFO reference', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { input, ops } = generate(seed);
    const src = toSource(ops);
    const vm = runSource(src, input);
    const ref = reference(input, ops);

    for (const sec of SECS) {
      const vmLots = vm.positions().filter((l) => l.security === sec);
      const refLots = ref.lots.filter((l) => l.sec === sec && fcmp(l.qty, g0) > 0);
      assert.equal(vmLots.length, refLots.length, `seed ${seed} ${sec} lot count`);
      for (let i = 0; i < vmLots.length; i++) {
        assert.equal(vmLots[i].id, refLots[i].id, `seed ${seed} ${sec} lot id #${i}`);
        assert.equal(fcmp([vmLots[i].qty.n, vmLots[i].qty.d], refLots[i].qty), 0, `seed ${seed} ${sec} lot qty #${i}`);
      }
    }
    assert.equal(fcmp([vm.cash.n, vm.cash.d], ref.cash), 0, `seed ${seed} cash`);
    assert.equal(vm.receivables.length, ref.receivables.length, `seed ${seed} receivable count`);
    for (let i = 0; i < vm.receivables.length; i++) {
      assert.equal(vm.receivables[i].security, ref.receivables[i].sec);
      const f = Fraction.parse(vm.receivables[i].qty);
      assert.equal(fcmp([f.n, f.d], ref.receivables[i].qty), 0, `seed ${seed} receivable #${i}`);
    }
  }
});
