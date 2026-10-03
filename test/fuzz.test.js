import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hashParts } from '../src/index.js';

// Seeded PRNG (mulberry32) for reproducible random programs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const roundShares = (x) => Math.round(x * 1e6) / 1e6;
const roundCash = (x) => Math.round(x * 1e2) / 1e2;

// ---------------------------------------------------------------------------
// Independent FIFO reference model. Written separately from the VM: plain
// objects, reduce-style, no shared code except the public hashParts helper
// used for the documented tie-break rule.
// ---------------------------------------------------------------------------
function refRun(lots0, cash0, events) {
  let lots = lots0.map((l, i) => ({ ...l, seq: i }));
  let cash = cash0;
  const ordered = events
    .map((e, i) => ({ ...e, srcSeq: i }))
    .sort((a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      (a.version - b.version) ||
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0) ||
      (a.srcSeq - b.srcSeq));
  for (const ev of ordered) {
    if (ev.kind === 'sell') {
      let need = ev.qty;
      lots = lots
        .slice()
        .sort((a, b) => (a.sec !== b.sec ? 0 : (a.acquired < b.acquired ? -1 : a.acquired > b.acquired ? 1 : a.seq - b.seq)))
        .map((l) => {
          if (l.sec !== ev.sec || need <= 0) return l;
          const take = Math.min(l.qty, need);
          need = roundShares(need - take);
          return { ...l, qty: roundShares(l.qty - take) };
        })
        .filter((l) => l.qty > 1e-9);
      if (need > 1e-6) throw new Error('reference: oversold');
    } else if (ev.kind === 'split') {
      const f = 1 / ev.ratio;
      lots = lots.map((l) => (l.sec === ev.sec && l.acquired < ev.date ? { ...l, qty: roundShares(l.qty * f) } : l));
    } else if (ev.kind === 'dividend') {
      const qty = lots.filter((l) => l.sec === ev.sec && l.acquired < ev.date).reduce((s, l) => s + l.qty, 0);
      cash = roundCash(cash + roundCash(roundShares(qty) * ev.amount));
    } else if (ev.kind === 'tender') {
      let shares = 0;
      lots = lots
        .map((l) => {
          if (l.sec !== ev.sec || l.acquired >= ev.date) return l;
          const sold = roundShares(l.qty * ev.fraction);
          shares += sold;
          return { ...l, qty: roundShares(l.qty - sold) };
        })
        .filter((l) => l.qty > 1e-9);
      cash = roundCash(cash + roundCash(roundShares(shares) * ev.price));
    }
  }
  return { lots, cash };
}

function fmtRatio(r) {
  // Emit ratios as fractions so the DSL text is exact.
  return `${r[0]}/${r[1]}`;
}

function actionHash(id, sec, kind, paramStr, ex, version) {
  return hashParts([id, sec, kind, paramStr, ex, String(version)]);
}

const RATIOS = [[1, 2], [1, 3], [1, 4], [2, 3], [3, 4]];
const FRACTIONS = [[1, 4], [1, 2], [3, 4], [1, 1]];

// Adapt lots.json shape ({security, quantity}) to the reference model's
// internal shape ({sec, qty}).
const toRefLots = (lots) => lots.map((l) => ({ id: l.id, sec: l.security, qty: l.quantity, acquired: l.acquired }));

function genCase(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const secs = ['AAA', 'BBB', 'CCC'].slice(0, 1 + Math.floor(rnd() * 3));
  const lots = [];
  let lotN = 0;
  for (const sec of secs) {
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const month = 1 + Math.floor(rnd() * 6);
      const day = 1 + Math.floor(rnd() * 28);
      lots.push({
        id: `L${lotN++}`,
        security: sec,
        quantity: 10 + Math.floor(rnd() * 490),
        acquired: `2024-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      });
    }
  }
  const cash0 = Math.floor(rnd() * 1000);
  const events = [];
  const nEvents = 4 + Math.floor(rnd() * 8);
  let actionN = 0;
  for (let i = 0; i < nEvents; i++) {
    const sec = pick(secs);
    const month = 7 + Math.floor(rnd() * 5);
    const day = 1 + Math.floor(rnd() * 28);
    const date = `2024-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const roll = rnd();
    if (roll < 0.3) {
      const ratio = pick(RATIOS);
      const id = `s${actionN++}`;
      const version = 1 + Math.floor(rnd() * 2);
      events.push({ kind: 'split', id, sec, ratio, ratioVal: ratio[0] / ratio[1], date, version });
    } else if (roll < 0.55) {
      const amount = Math.floor(rnd() * 500) / 100;
      const id = `d${actionN++}`;
      const version = 1 + Math.floor(rnd() * 2);
      events.push({ kind: 'dividend', id, sec, amount, date, version });
    } else if (roll < 0.75) {
      const price = 1 + Math.floor(rnd() * 5000) / 100;
      const fraction = pick(FRACTIONS);
      const id = `t${actionN++}`;
      const version = 1 + Math.floor(rnd() * 2);
      events.push({ kind: 'tender', id, sec, price, fraction, fractionVal: fraction[0] / fraction[1], date, version });
    } else {
      events.push({ kind: 'sell', sec, qty: 1 + Math.floor(rnd() * 600), date, version: -1, hash: '' });
    }
  }
  // Events execute in date order, not generation order, so clamp sells
  // against a date-ordered simulation of the reference model.
  const finalEvents = [];
  const ordered = events
    .map((e, i) => ({ ...e, srcSeq: i }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.version - b.version) || (a.srcSeq - b.srcSeq));
  for (const ev of ordered) {
    if (ev.kind === 'sell') {
      const soFar = refRun(toRefLots(lots), cash0, finalEvents.map(toRefEvent));
      const available = soFar.lots.filter((l) => l.sec === ev.sec).reduce((s, l) => s + l.qty, 0);
      const qty = Math.min(ev.qty, Math.floor(available));
      if (qty < 1) continue;
      ev.qty = qty;
    }
    finalEvents.push(ev);
  }
  const lines = finalEvents.map((ev) => {
    if (ev.kind === 'split') return `action ${ev.id}: ${ev.sec} split ${fmtRatio(ev.ratio)} ex ${ev.date} v${ev.version}`;
    if (ev.kind === 'dividend') return `action ${ev.id}: ${ev.sec} dividend $${ev.amount.toFixed(2)} ex ${ev.date} v${ev.version}`;
    if (ev.kind === 'tender') return `action ${ev.id}: ${ev.sec} tender $${ev.price.toFixed(2)} for ${fmtRatio(ev.fraction)} ex ${ev.date} v${ev.version}`;
    return `sell ${ev.sec} ${ev.qty} on ${ev.date}`;
  });
  const refEvents = finalEvents.map(toRefEvent);
  return { src: lines.join('\n') + '\n', input: { cash: cash0, lots }, events: refEvents };
}

// Project a generated event into the reference model's shape, computing the
// documented content hash used for the same-version tie-break.
function toRefEvent(ev) {
  if (ev.kind === 'sell') return { kind: 'sell', sec: ev.sec, qty: ev.qty, date: ev.date, version: -1, hash: '' };
  if (ev.kind === 'split') {
    const ratio = ev.ratio[0] / ev.ratio[1];
    return { kind: 'split', sec: ev.sec, ratio, date: ev.date, version: ev.version, hash: actionHash(ev.id, ev.sec, 'split', `ratio=${ratio}`, ev.date, ev.version) };
  }
  if (ev.kind === 'dividend') {
    return { kind: 'dividend', sec: ev.sec, amount: ev.amount, date: ev.date, version: ev.version, hash: actionHash(ev.id, ev.sec, 'dividend', `amount=${ev.amount}`, ev.date, ev.version) };
  }
  const fraction = ev.fraction[0] / ev.fraction[1];
  return { kind: 'tender', sec: ev.sec, price: ev.price, fraction, date: ev.date, version: ev.version, hash: actionHash(ev.id, ev.sec, 'tender', `price=${ev.price},fraction=${fraction}`, ev.date, ev.version) };
}

function normalize(state) {
  const lots = [];
  for (const [sec, p] of Object.entries(state.positions)) {
    for (const l of p.lots) lots.push({ sec, id: l.id, qty: l.quantity });
  }
  lots.sort((a, b) => (a.sec < b.sec ? -1 : a.sec > b.sec ? 1 : a.id < b.id ? -1 : 1));
  return { lots, cash: state.cash };
}

// Acceptance 4: random lots + action sequences vs an independent FIFO reference
for (const seed of [1, 7, 42, 1337, 20240, 555, 9001, 31337]) {
  test(`random program matches independent FIFO reference (seed ${seed})`, () => {
    const { src, input, events } = genCase(seed);
    const actual = run(src, input);
    const ref = refRun(toRefLots(input.lots), input.cash, events);
    const norm = normalize(actual);
    const refLots = ref.lots
      .map((l) => ({ sec: l.sec, id: l.id, qty: l.qty }))
      .sort((a, b) => (a.sec < b.sec ? -1 : a.sec > b.sec ? 1 : a.id < b.id ? -1 : 1));
    assert.equal(norm.lots.length, refLots.length, `lot count differs\nprogram:\n${src}`);
    for (let i = 0; i < norm.lots.length; i++) {
      assert.equal(norm.lots[i].sec, refLots[i].sec);
      assert.equal(norm.lots[i].id, refLots[i].id);
      assert.ok(Math.abs(norm.lots[i].qty - refLots[i].qty) < 1e-6,
        `lot ${norm.lots[i].id}: vm=${norm.lots[i].qty} ref=${refLots[i].qty}\nprogram:\n${src}`);
    }
    assert.ok(Math.abs(norm.cash - ref.cash) < 1e-6, `cash: vm=${norm.cash} ref=${ref.cash}\nprogram:\n${src}`);
    assert.equal(actual.adjustments.length, 0);
  });
}

test('fuzz programs are deterministic across runs', () => {
  const { src, input } = genCase(42);
  const a = normalize(run(src, input));
  const b = normalize(run(src, input));
  assert.deepEqual(a, b);
});
