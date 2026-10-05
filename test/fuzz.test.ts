import test from 'node:test';
import assert from 'node:assert/strict';
import { Rat } from '../src/rational';
import { Timeline, linear, step, smooth, Ease } from '../src/timeline';
import { Player, Mode, Marker, Fired } from '../src/player';

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const randRat = (r: () => number, maxNum: number, maxDen: number) =>
  Rat.of(rand(r, 0, maxNum), rand(r, 1, maxDen));

// ---------- Independent interval model (reference implementation) ----------

interface FloatKey { t: number; v: number; ease: Ease }

/** Float-only value model: independent of the rational code path. */
function floatValue(keys: FloatKey[], mode: Mode, t: number): number {
  const D = keys[keys.length - 1].t;
  if (D === 0) return keys[0].v;
  let l: number;
  const eps = 1e-9 * Math.max(1, D);
  if (t <= 0) l = 0;
  else if (mode === 'once') l = Math.min(t, D);
  else if (mode === 'loop') {
    l = t % D;
    if (Math.abs(l - D) <= eps) l = 0; // exact multiple of D maps to 0
  } else {
    let m = t % (2 * D);
    if (Math.abs(m - 2 * D) <= eps) m = 0;
    l = m <= D ? m : 2 * D - m;
  }
  // snap to exact key times: the rational model is exact, floats are not
  for (const k of keys) {
    if (Math.abs(l - k.t) <= 1e-9 * Math.max(1, Math.abs(k.t))) { l = k.t; break; }
  }
  if (l <= keys[0].t) return keys[0].v;
  if (l >= D) return keys[keys.length - 1].v;
  let i = 0;
  while (keys[i + 1].t <= l) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const alpha = (l - k0.t) / (k1.t - k0.t);
  return k0.v + (k1.v - k0.v) * k0.ease(alpha);
}

/** Per-cycle brute-force event model: independent structure from src. */
function refEvents(mode: Mode, markers: Marker[], dur: Rat, a: Rat, b: Rat): Fired[] {
  if (a.eq(b)) return [];
  const fwd = b.gt(a);
  const out: (Fired & { idx: number })[] = [];
  const consider = (mk: Marker, idx: number, h: Rat, slope: 1 | -1) => {
    const hit = fwd ? h.gt(a) && h.le(b) : h.ge(b) && h.lt(a);
    if (!hit) return;
    const dirSign = (fwd ? 1 : -1) * slope;
    out.push({ name: mk.name, at: h, dir: dirSign > 0 ? 'forward' : 'backward', idx });
  };
  if (mode === 'once') {
    markers.forEach((mk, i) => consider(mk, i, mk.t, 1));
  } else if (mode === 'loop') {
    const kMin = (fwd ? a : b).divFloor(dur) - 1n;
    const kMax = (fwd ? b : a).divFloor(dur) + 1n;
    for (let k = kMin; k <= kMax; k++) {
      const off = dur.mul(Rat.of(k));
      markers.forEach((mk, i) => consider(mk, i, mk.t.add(off), 1));
    }
  } else {
    const period = dur.mul(Rat.of(2n));
    const kMin = (fwd ? a : b).divFloor(period) - 1n;
    const kMax = (fwd ? b : a).divFloor(period) + 1n;
    for (let k = kMin; k <= kMax; k++) {
      const off = period.mul(Rat.of(k));
      markers.forEach((mk, i) => {
        const m = mk.t;
        if (m.isZero()) consider(mk, i, off, -1);
        else if (m.eq(dur)) consider(mk, i, dur.add(off), 1);
        else {
          consider(mk, i, m.add(off), 1);
          consider(mk, i, period.sub(m).add(off), -1);
        }
      });
    }
  }
  out.sort((x, y) => x.at.cmp(y.at) || x.idx - y.idx);
  if (!fwd) out.reverse();
  return out.map(({ name, at, dir }) => ({ name, at, dir }));
}

const canon = (fs: Fired[]) => fs.map((f) => `${f.name}@${f.at}:${f.dir}`).join('|');

// ---------- Random walk fuzz ----------

const EASES: Ease[] = [linear, step, smooth];
const MODES: Mode[] = ['once', 'loop', 'pingpong'];

test('random steps and large jumps match the interval model', () => {
  const r = rng(20261005);
  let valueChecks = 0;
  let eventChecks = 0;
  let firedTotal = 0;

  for (let scenario = 0; scenario < 60; scenario++) {
    const keyCount = rand(r, 2, 6);
    const times: Rat[] = [];
    let cursor = Rat.zero;
    for (let i = 0; i < keyCount; i++) {
      if (i > 0) cursor = cursor.add(randRat(r, 6, 4).add(Rat.of(1, 4)));
      times.push(cursor);
    }
    const keys = times.map((t) => ({
      t,
      v: rand(r, -100, 100),
      ease: EASES[rand(r, 0, EASES.length - 1)],
    }));
    const tl = new Timeline(keys);
    const dur = tl.duration;
    const floatKeys: FloatKey[] = keys.map((k) => ({ t: k.t.toNumber(), v: k.v, ease: k.ease! }));

    const markers: Marker[] = [];
    const markerCount = rand(r, 0, 5);
    for (let i = 0; i < markerCount; i++) {
      const m = randRat(r, 24, 4).mul(dur).div(Rat.of(6));
      markers.push({ name: `m${i}`, t: m.le(dur) ? m : dur });
    }
    const mode = MODES[rand(r, 0, 2)];
    const p = new Player(tl, { mode, markers });

    let refTime = Rat.zero;
    const steps = 120;
    for (let s = 0; s < steps; s++) {
      if (r() < 0.1) {
        // random seek (no events); occasionally negative to test clamping
        const target = randRat(r, 40, 4).mul(dur);
        const signed = r() < 0.2 ? target.neg() : target;
        p.seek(signed);
        refTime = signed.lt(Rat.zero) ? Rat.zero : signed;
      } else {
        // random delta: mostly small, sometimes a huge jump across many cycles
        const huge = r() < 0.08;
        const scale = huge ? rand(r, 100, 5000) : rand(r, 1, 8);
        let delta = randRat(r, 12, 4).mul(dur).mul(Rat.of(scale)).div(Rat.of(3));
        if (r() < 0.4) delta = delta.neg();
        const from = p.time;
        const got = p.advance(delta);
        let expectedTo = from.add(delta);
        if (expectedTo.lt(Rat.zero)) expectedTo = Rat.zero;
        refTime = expectedTo;
        const want = refEvents(mode, markers, dur, from, expectedTo);
        assert.equal(canon(got), canon(want), `events scenario=${scenario} step=${s}`);
        eventChecks++;
        firedTotal += got.length;
      }
      assert.ok(p.time.eq(refTime), `time scenario=${scenario} step=${s}`);
      const gotV = p.value();
      const wantV = floatValue(floatKeys, mode, refTime.toNumber());
      const tol = 1e-9 * Math.max(1, Math.abs(wantV));
      assert.ok(Math.abs(gotV - wantV) <= tol, `value scenario=${scenario} step=${s}: ${gotV} vs ${wantV}`);
      valueChecks++;
    }
  }
  console.log(`  fuzz: ${valueChecks} value checks, ${eventChecks} event steps, ${firedTotal} crossings verified`);
});

test('direct evaluation is path-independent (seek == advance == fresh)', () => {
  const r = rng(777);
  const keys = [
    { t: Rat.of(0), v: 3 },
    { t: Rat.of(2, 3), v: -7 },
    { t: Rat.of(5, 2), v: 11 },
  ];
  const tl = new Timeline(keys);
  const dur = tl.duration;
  for (const mode of MODES) {
    const a = new Player(tl, { mode });
    const b = new Player(tl, { mode });
    const c = new Player(tl, { mode });
    for (let i = 0; i < 200; i++) {
      const t = randRat(r, 60, 6).mul(dur);
      a.seek(t);
      // b reaches t by one signed jump from wherever it is
      b.advance(t.sub(b.time));
      // c replays from 0 in two halves
      c.seek(Rat.zero);
      const half = t.div(Rat.of(2));
      c.advance(half);
      c.advance(t.sub(half));
      assert.equal(a.value(), b.value(), `${mode} t=${t}`);
      assert.equal(a.value(), c.value(), `${mode} t=${t}`);
    }
  }
});
