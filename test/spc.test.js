import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPCEngine } from '../src/spc.js';
import { naiveEvaluate, normalizeRules } from '../src/naive.js';
import { FaultInjector, replayLog, mulberry32 } from '../src/faults.js';

// --- helpers ---------------------------------------------------------------

function makeRandn(seed) {
  const rand = mulberry32(seed);
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// Independent brute-force check, written separately from src/naive.js:
// does `ruleName` fire on these values against fixed (mu, sigma)?
function bruteCheck(ruleName, rules, values, mu, sigma) {
  const cfg = normalizeRules(rules)[ruleName];
  const side = (v) => (v > mu ? 1 : v < mu ? -1 : 0);
  const beyond = (v, k) => Math.abs(v - mu) > k * sigma;
  if (ruleName === 'beyondSigma') return values.some((v) => beyond(v, cfg.k));
  if (ruleName === 'twoOfThree' || ruleName === 'fourOfFive') {
    if (values.length < cfg.n) return false;
    const w = Math.min(cfg.of, values.length);
    for (let i = 0; i + w <= values.length; i++) {
      let plus = 0;
      let minus = 0;
      for (let j = i; j < i + w; j++) {
        if (beyond(values[j], cfg.k)) {
          if (side(values[j]) === 1) plus++;
          if (side(values[j]) === -1) minus++;
        }
      }
      if (plus >= cfg.n || minus >= cfg.n) return true;
    }
    return false;
  }
  if (ruleName === 'runSide') {
    let best = 0;
    let run = 0;
    let prev = 0;
    for (const v of values) {
      const s = side(v);
      run = s !== 0 && s === prev ? run + 1 : s === 0 ? 0 : 1;
      prev = s;
      if (run > best) best = run;
    }
    return best >= cfg.run;
  }
  throw new Error(`unknown rule ${ruleName}`);
}

// Verify "remove any single point and the alarm disappears" for every alarm,
// against the window limits the alarm was raised with.
function assertAllAlarmsMinimal(engine, options) {
  const state = engine.getState();
  const rules = normalizeRules(options.rules);
  const { center: mu, sigma } = state.controlLimits;
  const valueOf = new Map();
  for (const e of engine.entries) if (e.valid) valueOf.set(e.id, e.value);
  for (const alarm of state.alarms) {
    const subset = alarm.minimalSubset;
    const vals = subset.map((id) => valueOf.get(id));
    assert.ok(
      bruteCheck(alarm.rule, options.rules, vals, mu, sigma),
      `witness of ${alarm.id} must still trigger the rule`,
    );
    for (const id of subset) {
      const reduced = subset.filter((x) => x !== id).map((x) => valueOf.get(x));
      assert.ok(
        !bruteCheck(alarm.rule, options.rules, reduced, mu, sigma),
        `removing ${id} from ${alarm.id} witness must kill the alarm`,
      );
    }
    assert.ok(subset.length <= alarm.pointIds.length);
    void rules;
  }
}

function alarmKeys(state) {
  return state.alarms
    .map((a) => `${a.rule}|${a.side}|${a.pointIds.join(',')}`)
    .sort();
}

function assertLimitsClose(actual, expected) {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  for (const k of ['center', 'sigma', 'ucl', 'lcl']) {
    const tol = Math.max(1e-9, Math.abs(expected[k]) * 1e-9);
    assert.ok(
      Math.abs(actual[k] - expected[k]) <= tol,
      `limit ${k}: ${actual[k]} vs ${expected[k]}`,
    );
  }
  assert.equal(actual.n, expected.n);
}

// --- acceptance 1: 200-point random stream matches naive reference ---------

test('200-point random stream matches naive reference', () => {
  const randn = makeRandn(42);
  const options = { windowSize: 80, minSamples: 5 };
  const engine = new SPCEngine(options);
  const points = [];
  for (let i = 1; i <= 200; i++) {
    const p = { id: `p${i}`, value: 50 + 2 * randn() };
    points.push(p);
    engine.insert(p);
  }
  const state = engine.getState();
  const ref = naiveEvaluate(points, options);
  assert.equal(state.status, ref.status);
  assert.deepEqual(alarmKeys(state), alarmKeys(ref));
  assertLimitsClose(state.controlLimits, ref.controlLimits);
  assertAllAlarmsMinimal(engine, options);
});

test('incremental inserts match naive at every step', () => {
  const randn = makeRandn(7);
  const options = { windowSize: 30, minSamples: 5 };
  const engine = new SPCEngine(options);
  const points = [];
  for (let i = 1; i <= 60; i++) {
    const p = { id: `q${i}`, value: 10 + randn() };
    points.push(p);
    engine.insert(p);
    const ref = naiveEvaluate(points, options);
    const state = engine.getState();
    assert.equal(state.status, ref.status, `step ${i}`);
    assert.deepEqual(alarmKeys(state), alarmKeys(ref), `step ${i}`);
  }
});

// --- acceptance 2: corrections and invalidations match full recompute ------

test('correcting historical points keeps alarms equal to full recompute', () => {
  const randn = makeRandn(99);
  const options = { windowSize: 150, minSamples: 5 };
  const engine = new SPCEngine(options);
  const points = [];
  for (let i = 1; i <= 200; i++) {
    const p = { id: `c${i}`, value: 20 + randn() };
    points.push(p);
    engine.insert(p);
  }
  // correct several historical points, one of them to an outlier
  const fixes = [
    ['c17', 20.5],
    ['c88', 35], // outlier -> should alarm
    ['c150', 19.8],
  ];
  for (const [id, v] of fixes) {
    engine.correct(id, v);
    points.find((p) => p.id === id).value = v;
  }
  let state = engine.getState();
  let ref = naiveEvaluate(points, options);
  assert.equal(state.status, ref.status);
  assert.deepEqual(alarmKeys(state), alarmKeys(ref));
  assertLimitsClose(state.controlLimits, ref.controlLimits);
  assert.ok(state.alarms.some((a) => a.rule === 'beyondSigma' && a.pointIds.includes('c88')));

  // invalidate a historical range; compare against recompute without them
  engine.invalidate(100, 120);
  const remaining = points.filter((p) => {
    const seq = Number(p.id.slice(1));
    return seq < 100 || seq > 120;
  });
  state = engine.getState();
  ref = naiveEvaluate(remaining, options);
  assert.equal(state.status, ref.status);
  assert.deepEqual(alarmKeys(state), alarmKeys(ref));
  assertLimitsClose(state.controlLimits, ref.controlLimits);
  assertAllAlarmsMinimal(engine, options);
});

// --- acceptance 3: unit injection is reproducible --------------------------

test('unit injection produces reproducible ERR_UNIT flags', () => {
  const randn = makeRandn(5);
  const options = { minSamples: 5, unit: { expected: 'mm', autoDetect: true, factor: 5 } };
  const engine = new SPCEngine(options);
  for (let i = 1; i <= 30; i++) {
    engine.insert({ id: `m${i}`, value: 100 + randn(), unit: 'mm' });
  }
  const injector = new FaultInjector(engine, { seed: 3 });
  // device reports a 100 mm part as 3.937 "in"
  const res = injector.changeUnit({ id: 'u1', value: 100 }, 'in');
  assert.deepEqual(res.flags, ['ERR_UNIT']);

  let state = engine.getState();
  assert.equal(state.validCount, 30); // flagged point excluded from stats
  const flagged = state.flaggedPoints.find((f) => f.id === 'u1');
  assert.ok(flagged, 'u1 flagged');
  assert.ok(flagged.flags.includes('ERR_UNIT'));

  // value-only unit fault (no unit tag) caught by autoDetect
  engine.insert({ id: 'u2', value: 100 / 25.4 });
  state = engine.getState();
  assert.ok(state.flaggedPoints.find((f) => f.id === 'u2')?.flags.includes('ERR_UNIT'));
  assert.equal(state.validCount, 30);

  // replaying the log reproduces the exact same state
  const replayed = replayLog(engine.log, options);
  assert.deepEqual(replayed.getState(), engine.getState());
});

test('dropped and reordered points replay identically', () => {
  const randn = makeRandn(11);
  const options = { minSamples: 5 };
  const points = [];
  for (let i = 1; i <= 50; i++) points.push({ id: `r${i}`, value: 5 + randn() });

  const inOrder = new SPCEngine(options);
  for (const p of points) inOrder.insert(p);

  const shuffledEngine = new SPCEngine(options);
  const injector = new FaultInjector(shuffledEngine, { seed: 77 });
  injector.reorder(points.slice(0, 25));
  injector.drop(points[25]); // lost on the wire
  for (const p of points.slice(26)) shuffledEngine.insert(p);

  const state = shuffledEngine.getState();
  assert.equal(state.validCount, 49); // one dropped
  // reordered prefix converges to the same state as in-order insertion
  const refPoints = [...points.slice(0, 25), ...points.slice(26)];
  const ref = naiveEvaluate(refPoints, options);
  assert.deepEqual(alarmKeys(state), alarmKeys(ref));
  assertLimitsClose(state.controlLimits, ref.controlLimits);
  assert.deepEqual(replayLog(shuffledEngine.log, options).getState(), state);
  void inOrder;
});

// --- acceptance 4: insufficient samples -> UNKNOWN, never "normal" ---------

test('insufficient samples yield UNKNOWN', () => {
  const engine = new SPCEngine({ minSamples: 5 });
  assert.equal(engine.getState().status, 'UNKNOWN'); // empty
  engine.insert({ id: 'a', value: 1 });
  assert.equal(engine.getState().status, 'UNKNOWN'); // single point
  assert.equal(engine.getState().controlLimits, null);
  engine.insert({ id: 'b', value: 2 });
  engine.insert({ id: 'c', value: 3 });
  engine.insert({ id: 'd', value: 4 });
  assert.equal(engine.getState().status, 'UNKNOWN'); // still < minSamples
  engine.insert({ id: 'e', value: 5 });
  assert.equal(engine.getState().status, 'OK'); // enough now

  // invalidate everything -> UNKNOWN again, not "normal"
  engine.invalidate(1, 5);
  const state = engine.getState();
  assert.equal(state.status, 'UNKNOWN');
  assert.equal(state.validCount, 0);
  assert.equal(state.controlLimits, null);
  assert.deepEqual(state.alarms, []);
});

// --- edge cases ------------------------------------------------------------

test('constant stream: zero sigma, collapsed limits, no alarms', () => {
  const engine = new SPCEngine({ minSamples: 5 });
  for (let i = 1; i <= 20; i++) engine.insert({ id: `k${i}`, value: 42 });
  const state = engine.getState();
  assert.equal(state.status, 'OK');
  assert.equal(state.controlLimits.sigma, 0);
  assert.equal(state.controlLimits.ucl, 42);
  assert.equal(state.controlLimits.lcl, 42);
  assert.deepEqual(state.alarms, []);

  // a single deviating point on a constant stream trips rule 1
  engine.insert({ id: 'spike', value: 42.5 });
  const after = engine.getState();
  assert.equal(after.status, 'ALARM');
  assert.ok(after.alarms.some((a) => a.rule === 'beyondSigma' && a.pointIds.includes('spike')));
});

test('single point and all-invalidated streams stay UNKNOWN', () => {
  const single = new SPCEngine();
  single.insert({ id: 'only', value: 7 });
  assert.equal(single.getState().status, 'UNKNOWN');

  const all = new SPCEngine({ minSamples: 2 });
  all.insert({ id: 'x1', value: 1 });
  all.insert({ id: 'x2', value: 2 });
  all.insert({ id: 'x3', value: 3 });
  all.invalidate(1, 3);
  assert.equal(all.getState().status, 'UNKNOWN');
  assert.equal(all.getState().validCount, 0);
});

// --- minimal triggering subsets per rule -----------------------------------

test('minimal subsets for each Western Electric rule', () => {
  const options = { minSamples: 5 };

  // rule 1: one point beyond 3 sigma
  const e1 = new SPCEngine(options);
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10].forEach((v, i) => e1.insert({ id: `a${i}`, value: v }));
  const a1 = e1.getState().alarms.find((a) => a.rule === 'beyondSigma');
  assert.ok(a1);
  assert.deepEqual(a1.minimalSubset, ['a10']);

  // rule 2: 2 of 3 beyond 2 sigma on one side
  const e2 = new SPCEngine(options);
  [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 3].forEach((v, i) => e2.insert({ id: `b${i}`, value: v }));
  const a2 = e2.getState().alarms.find((a) => a.rule === 'twoOfThree');
  assert.ok(a2);
  assert.equal(a2.minimalSubset.length, 2); // the two extreme points suffice

  // rule 3: 4 of 5 beyond 1 sigma
  const e3 = new SPCEngine(options);
  [0, 0, 0, 0, 0, 0, 1.5, 1.5, 1.5, 1.5, 0].forEach((v, i) => e3.insert({ id: `d${i}`, value: v }));
  const a3 = e3.getState().alarms.find((a) => a.rule === 'fourOfFive');
  assert.ok(a3);
  assert.equal(a3.minimalSubset.length, 4);

  // rule 4: 8 in a row on one side of the center line
  const e4 = new SPCEngine(options);
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1].forEach((v, i) => e4.insert({ id: `r${i}`, value: v }));
  const a4 = e4.getState().alarms.find((a) => a.rule === 'runSide');
  assert.ok(a4);
  assert.equal(a4.minimalSubset.length, 8);

  for (const [engine, opts] of [
    [e1, options],
    [e2, options],
    [e3, options],
    [e4, options],
  ]) {
    assertAllAlarmsMinimal(engine, opts);
  }
});

test('rules are configurable (subset + thresholds)', () => {
  // only runSide enabled, run length 4
  const engine = new SPCEngine({ minSamples: 3, rules: { runSide: { run: 4 }, beyondSigma: { enabled: false }, twoOfThree: { enabled: false }, fourOfFive: { enabled: false } } });
  [0, 0, 1, 1, 1, 1].forEach((v, i) => engine.insert({ id: `s${i}`, value: v }));
  const state = engine.getState();
  assert.ok(state.alarms.every((a) => a.rule === 'runSide'));
  assert.ok(state.alarms.length >= 1);
});
