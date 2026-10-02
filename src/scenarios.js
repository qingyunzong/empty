import { LimitEngine } from './engine.js';
import { refOccupancyAt, refCheckTimeline } from './ref.js';

export function scenario1() {
  const engine = new LimitEngine({
    totalLimit: 1000,
    dailyCaps: { DINING: 500, TRAVEL: 800 },
    periodMinutes: 60,
    dayMinutes: 120,
  });
  const log = [];
  log.push(engine.apply({ op: 'freeze', id: 'A', category: 'DINING', amount: 300, start: 0, end: 90 }));
  log.push(engine.apply({ op: 'freeze', id: 'B', category: 'TRAVEL', amount: 400, start: 30, end: 120 }));
  log.push(engine.apply({ op: 'freeze', id: 'C', category: 'DINING', amount: 200, start: 60, end: 150 }));
  log.push(engine.apply({ op: 'capture', id: 'B', start: 30, end: 50, amount: 150, at: 50 }));
  const beforeReset = engine.occupancyAt(59);
  const afterReset = engine.occupancyAt(61);
  log.push(engine.apply({ op: 'sweep', at: 130 }));
  return {
    title: 'S1 three overlapping freezes across period resets (reset at t=60,120)',
    config: engineConfigOf(engine),
    occupancy: { beforeReset_t59: beforeReset, afterReset_t61: afterReset },
    log,
  };
}

export function scenario2() {
  const engine = new LimitEngine({
    totalLimit: 500,
    dailyCaps: { SHOPPING: 300 },
    periodMinutes: 240,
    dayMinutes: 240,
  });
  const log = [];
  log.push(engine.apply({ op: 'freeze', id: 'H', category: 'SHOPPING', amount: 100, start: 0, end: 100 }));
  log.push(engine.apply({ op: 'unfreeze', id: 'H', start: 40, end: 60 }));
  const afterSplit = engine.state();
  const fragmentsAfterSplit = engine.holds.map((h) => ({ ...h }));
  log.push(engine.apply({ op: 'freeze', id: 'H2', category: 'SHOPPING', amount: 100, start: 40, end: 60 }));
  const afterMerge = engine.state();
  return {
    title: 'S2 partial unfreeze splits interval, refill merges fragments',
    config: engineConfigOf(engine),
    fragmentsAfterSplit,
    log,
    proof: {
      splitSegments: afterSplit.segments.map((s) => [s.start, s.end]),
      occupantSegments: afterMerge.segments.map((s) => [s.start, s.end]),
      mergedSegments: afterMerge.coalesced.map((s) => [s.start, s.end]),
      mergeProof: afterMerge.merges,
    },
  };
}

export function scenario3() {
  const run = (ops) => {
    const engine = new LimitEngine({ totalLimit: 100, dailyCaps: {}, periodMinutes: 60, dayMinutes: 120 });
    return engine.applyBatch(ops);
  };
  const base = [
    { op: 'freeze', id: 'r1', category: 'M', amount: 60, start: 0, end: 30, priority: 5, seq: 1 },
    { op: 'freeze', id: 'r2', category: 'M', amount: 60, start: 0, end: 30, priority: 5, seq: 2 },
    { op: 'freeze', id: 'r3', category: 'M', amount: 60, start: 0, end: 30, priority: 5, seq: 3 },
  ];
  const forward = run(base);
  const shuffled = run([base[2], base[0], base[1]]);
  const outcome = (rs) => Object.fromEntries(
    rs.map((r) => [r.op, { ok: r.ok, code: r.code ?? null }]),
  );
  const raceEngine = new LimitEngine({ totalLimit: 100, dailyCaps: {}, periodMinutes: 60, dayMinutes: 120 });
  raceEngine.apply({ op: 'freeze', id: 'x', category: 'M', amount: 10, start: 0, end: 10 });
  const stale = raceEngine.apply({ op: 'freeze', id: 'y', category: 'M', amount: 10, start: 0, end: 10, expectedVersion: 0 });
  return {
    title: 'S3 concurrent equal requests: deterministic single winner',
    config: { totalLimit: 100, periodMinutes: 60, dayMinutes: 120, dailyCaps: {} },
    forward: forward.map(stripState),
    shuffledSubmission: shuffled.map(stripState),
    deterministic: JSON.stringify(outcome(forward)) === JSON.stringify(outcome(shuffled)),
    staleVersionRejected: stale,
  };
}

export function scenario4() {
  const cfg = {
    totalLimit: 250,
    dailyCaps: { A: 150, B: 150 },
    periodMinutes: 120,
    dayMinutes: 240,
    anchor: 0,
  };
  const engine = new LimitEngine(cfg);
  let seed = 20261002;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const T = 480;
  let accepted = 0;
  let rejected = 0;
  let idSeq = 0;
  const openIds = [];
  for (let i = 0; i < 60; i++) {
    const roll = rand();
    if (roll < 0.6 || openIds.length === 0) {
      const id = `h${idSeq++}`;
      const start = Math.floor(rand() * (T - 60));
      const end = start + 10 + Math.floor(rand() * 100);
      const amount = 10 + Math.floor(rand() * 60);
      const category = rand() < 0.5 ? 'A' : 'B';
      const r = engine.apply({ op: 'freeze', id, category, amount, start, end });
      if (r.ok) { accepted += 1; openIds.push(id); } else { rejected += 1; }
    } else if (roll < 0.8) {
      const id = openIds[Math.floor(rand() * openIds.length)];
      const h = engine.holds.find((x) => x.id === id);
      if (!h) continue;
      const s = h.start + Math.floor(rand() * Math.max(1, h.end - h.start));
      const e = s + 1 + Math.floor(rand() * Math.max(1, h.end - s));
      engine.apply({ op: 'unfreeze', id, start: s, end: e });
    } else {
      const id = openIds[Math.floor(rand() * openIds.length)];
      const h = engine.holds.find((x) => x.id === id);
      if (!h) continue;
      engine.apply({ op: 'capture', id, start: h.start, end: h.end, at: h.start });
    }
  }
  let mismatches = 0;
  const state = engine.state();
  for (let t = 0; t < T; t++) {
    const a = engine.occupancyAt(t);
    const b = refOccupancyAt(engine.holds, engine.captures, t, cfg);
    if (a.total !== b.total || JSON.stringify(a.byCategory) !== JSON.stringify(b.byCategory)) {
      mismatches += 1;
    }
    const seg = state.segments.find((s) => s.start <= t && t < s.end);
    const segTotal = seg ? seg.total : 0;
    if (segTotal !== b.total) mismatches += 1;
  }
  const ref = refCheckTimeline(engine.holds, engine.captures, cfg, 0, T);
  return {
    title: 'S4 minute-by-minute timeline cross-check vs reference implementation',
    config: cfg,
    timeline: { minutes: T, acceptedFreezes: accepted, rejectedFreezes: rejected },
    result: {
      mismatches,
      maxOccupancy: ref.maxTotal,
      totalLimit: cfg.totalLimit,
      violations: ref.violations,
      finalSegments: state.segments.length,
      mergeProofs: state.merges.length,
    },
  };
}

export const scenarios = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4 };

function stripState(r) {
  const { state, ...rest } = r;
  return rest;
}

function engineConfigOf(engine) {
  return {
    totalLimit: engine.totalLimit,
    dailyCaps: engine.dailyCaps,
    periodMinutes: engine.periodMinutes,
    dayMinutes: engine.dayMinutes,
  };
}
