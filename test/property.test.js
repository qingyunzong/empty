import test from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../src/index.js';

// 简单策略: 无作用域/守卫, 便于独立参考实现逐项对照
const SRC = `
customer C1001;
note_whitelist /^REQ-[0-9]+$/;
bucket a limit 100000;
bucket b limit 50000;
`;

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genEvents(seed, n) {
  const rnd = mulberry32(seed);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const dayOf = (d) => `2026-${String(1 + Math.floor(d / 28)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`;
  const events = [];
  const notes = [];
  for (let i = 0; i < n; i++) {
    const day = ri(0, 80);
    const ts = `${dayOf(day)}T${String(ri(0, 23)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}:00Z`;
    const bucket = pick(['a', 'b']);
    const kind = pick(['freeze', 'freeze', 'freeze', 'unfreeze', 'draw', 'debit', 'tick']);
    if (kind === 'tick') {
      events.push({ id: `t${i}`, type: 'tick', date: dayOf(day) });
      continue;
    }
    if (kind === 'freeze') {
      const note = rnd() < 0.1 ? 'BAD' : `REQ-${ri(1, 40)}`;
      notes.push(note);
      events.push({
        id: `e${i}`, ts, type: 'freeze', bucket,
        amount: ri(-5, 30000), note, until: dayOf(day + ri(1, 30)),
      });
    } else if (kind === 'unfreeze') {
      events.push({
        id: `e${i}`, ts, type: 'unfreeze', bucket,
        ref: pick(notes.length ? notes : ['REQ-1']), amount: ri(-10, 20000),
      });
    } else if (kind === 'draw') {
      events.push({
        id: `e${i}`, ts, type: 'draw', bucket,
        ref: pick(notes.length ? notes : ['REQ-1']), amount: ri(1, 20000),
      });
    } else {
      events.push({ id: `e${i}`, ts, type: 'debit', bucket, amount: ri(-3, 15000) });
    }
  }
  return events;
}

// 独立枚举参考实现: 不依赖 src/, 逐事件直译语义
function reference(events) {
  const buckets = {
    a: { available: 100000, frozen: 0, used: 0 },
    b: { available: 50000, frozen: 0, used: 0 },
  };
  const freezes = [];
  const wl = /^REQ-[0-9]+$/;
  const tsOf = (ev) => {
    const s = ev.type === 'tick' ? `${ev.date}T00:00:00Z` : ev.ts;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? Infinity : ms;
  };
  const sorted = events
    .map((ev, seq) => ({ ev, seq }))
    .sort((x, y) => {
      const a = tsOf(x.ev);
      const b = tsOf(y.ev);
      if (a !== b) return a < b ? -1 : 1;
      const ai = String(x.ev.id ?? '');
      const bi = String(y.ev.id ?? '');
      if (ai !== bi) return ai < bi ? -1 : 1;
      return x.seq - y.seq;
    });
  let day = null;
  for (const { ev } of sorted) {
    const d = ev.type === 'tick' ? ev.date : (typeof ev.ts === 'string' ? ev.ts.slice(0, 10) : null);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (day === null) day = d;
    else if (d > day) {
      for (const f of freezes) {
        if (f.status === 'active' && f.until <= d) {
          const rel = f.amount - f.used - f.released;
          buckets[f.bucket].frozen -= rel;
          buckets[f.bucket].available += rel;
          f.status = 'expired';
        }
      }
      day = d;
    }
    const b = buckets[ev.bucket];
    if (!b) continue;
    if (ev.type === 'freeze') {
      if (!Number.isSafeInteger(ev.amount) || ev.amount <= 0) continue;
      if (typeof ev.note !== 'string' || !wl.test(ev.note)) continue;
      if (typeof ev.until !== 'string' || ev.until <= d) continue;
      if (freezes.some((f) => f.bucket === ev.bucket && f.note === ev.note && f.status === 'active')) continue;
      if (b.available < ev.amount) continue;
      b.available -= ev.amount;
      b.frozen += ev.amount;
      freezes.push({ bucket: ev.bucket, note: ev.note, amount: ev.amount, used: 0, released: 0, until: ev.until, status: 'active' });
    } else if (ev.type === 'unfreeze') {
      if (!Number.isSafeInteger(ev.amount) || ev.amount <= 0) continue;
      const f = freezes.find((x) => x.bucket === ev.bucket && x.note === ev.ref && x.status === 'active');
      if (!f) continue;
      const rel = Math.min(ev.amount, f.amount - f.used - f.released);
      if (rel <= 0) continue;
      b.frozen -= rel;
      b.available += rel;
      f.released += rel;
      if (f.amount - f.used - f.released === 0) f.status = 'released';
    } else if (ev.type === 'draw') {
      if (!Number.isSafeInteger(ev.amount) || ev.amount <= 0) continue;
      const f = freezes.find((x) => x.bucket === ev.bucket && x.note === ev.ref && x.status === 'active');
      if (!f) continue;
      if (ev.amount > f.amount - f.used - f.released) continue;
      f.used += ev.amount;
      b.frozen -= ev.amount;
      b.used += ev.amount;
    } else if (ev.type === 'debit') {
      if (!Number.isSafeInteger(ev.amount) || ev.amount <= 0) continue;
      if (b.available < ev.amount) continue;
      b.available -= ev.amount;
      b.used += ev.amount;
    }
  }
  return buckets;
}

for (const seed of [1, 7, 42, 1337, 20261003]) {
  test(`随机事件流 vs 独立枚举参考 (seed=${seed}): 最终三额一致`, () => {
    const events = genEvents(seed, 400);
    const { state } = runAll(SRC, events);
    const ref = reference(events);
    for (const name of ['a', 'b']) {
      const got = state.buckets.get(name);
      assert.deepEqual(
        { available: got.available, frozen: got.frozen, used: got.used },
        ref[name],
        `bucket ${name} mismatch`,
      );
      // 不变式: available + frozen + used == limit
      assert.equal(got.available + got.frozen + got.used, got.limit);
    }
  });
}
