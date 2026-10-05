import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Rational,
  rat,
  PiecewiseLinear,
  simulate,
  verify,
  formatReport,
  type SimulationResult,
  type ThermostatConfig,
} from "../src/index.js";

// ---------- Rational ----------

test("rational: reduction, sign normalisation, arithmetic", () => {
  assert.equal(rat(4, 6).toString(), "2/3");
  assert.equal(rat(-3, -9).toString(), "1/3");
  assert.equal(rat(5, -10).toString(), "-1/2");
  assert.equal(rat(7).toString(), "7");
  assert.equal(rat(1, 2).add(rat(1, 3)).toString(), "5/6");
  assert.equal(rat(1, 2).sub(rat(2, 3)).toString(), "-1/6");
  assert.equal(rat(2, 3).mul(rat(9, 4)).toString(), "3/2");
  assert.equal(rat(1, 2).div(rat(3, 4)).toString(), "2/3");
  assert.equal(rat(-1, 2).abs().toString(), "1/2");
  assert.ok(rat(1, 3).lt(rat(1, 2)));
  assert.ok(rat(2, 4).eq(rat(1, 2)));
  assert.ok(rat(3, 2).ge(rat(3, 2)));
  assert.throws(() => rat(1, 0));
});

// ---------- PiecewiseLinear ----------

test("piecewise: exact interpolation, slope, clamping", () => {
  const f = PiecewiseLinear.fromPairs([
    [rat(0), rat(10)],
    [rat(4), rat(2)],
    [rat(10), rat(20)],
  ]);
  assert.equal(f.valueAt(rat(0)).toString(), "10");
  assert.equal(f.valueAt(rat(1)).toString(), "8"); // 10 - 2*1
  assert.equal(f.valueAt(rat(3, 2)).toString(), "7");
  assert.equal(f.valueAt(rat(7)).toString(), "11"); // 2 + 3*3
  assert.equal(f.valueAt(rat(-5)).toString(), "10"); // clamped
  assert.equal(f.valueAt(rat(99)).toString(), "20"); // clamped
  assert.equal(f.slopeAt(rat(2)).toString(), "-2");
  assert.equal(f.slopeAt(rat(4)).toString(), "3"); // right slope at breakpoint
  assert.equal(f.slopeAt(rat(10)).toString(), "0");
  assert.deepEqual(
    f.cutPoints(rat(1), rat(9)).map(String),
    ["1", "4", "9"],
  );
  assert.throws(
    () => PiecewiseLinear.fromPairs([[rat(1), rat(0)], [rat(1), rat(2)]]),
  );
});

// ---------- helpers ----------

function constant(value: Rational): PiecewiseLinear {
  return PiecewiseLinear.fromPairs([[rat(0), value]]);
}

function run(cfg: Partial<ThermostatConfig> & Pick<ThermostatConfig, "initial" | "horizon">): SimulationResult {
  return simulate({
    externalTemp: constant(rat(0)),
    heatingRate: constant(rat(0)),
    onThreshold: rat(18),
    offThreshold: rat(24),
    minOn: rat(0),
    minOff: rat(0),
    ...cfg,
  });
}

// ---------- closed-interval threshold, exact rational events ----------

test("closed interval: switch exactly when threshold is reached", () => {
  const res = run({
    externalTemp: PiecewiseLinear.fromPairs([[rat(0), rat(20)], [rat(10), rat(10)]]),
    heatingRate: constant(rat(3)),
    initial: { t: rat(0), temp: rat(20), heaterOn: false },
    horizon: rat(10),
  });
  assert.equal(res.events.length, 2);
  const [on, off] = res.events;
  assert.equal(on!.action, "HEATER_ON");
  assert.equal(on!.time.toString(), "2");
  assert.equal(on!.temperature.toString(), "18"); // exactly onThreshold
  assert.equal(on!.reason, "THRESHOLD_REACHED");
  assert.equal(off!.action, "HEATER_OFF");
  assert.equal(off!.time.toString(), "5");
  assert.equal(off!.temperature.toString(), "24"); // exactly offThreshold
  assert.equal(res.finalState.temp.toString(), "19");
  assert.equal(res.finalState.heaterOn, false);
  const report = verify(res, { subdivisions: 8 });
  assert.ok(report.ok, formatReport(report));
});

test("event times are exact rationals (fractional crossings)", () => {
  const res = run({
    externalTemp: PiecewiseLinear.fromPairs([[rat(0), rat(20)], [rat(9), rat(17)]]),
    heatingRate: constant(rat(2)),
    onThreshold: rat(37, 2), // 18.5
    offThreshold: rat(20),
    initial: { t: rat(0), temp: rat(20), heaterOn: false },
    horizon: rat(9),
  });
  assert.equal(res.events.length, 2);
  assert.equal(res.events[0]!.time.toString(), "9/2");
  assert.equal(res.events[0]!.temperature.toString(), "37/2");
  assert.equal(res.events[1]!.time.toString(), "27/5");
  assert.equal(res.events[1]!.temperature.toString(), "20");
  assert.equal(res.finalState.temp.toString(), "94/5");
  const report = verify(res, { subdivisions: 6 });
  assert.ok(report.ok, formatReport(report));
});

test("closed interval at t0: initial state exactly on threshold switches immediately", () => {
  const res = run({
    heatingRate: constant(rat(5)),
    onThreshold: rat(10),
    offThreshold: rat(20),
    minOn: rat(4),
    minOff: rat(3),
    initial: { t: rat(0), temp: rat(10), heaterOn: false }, // temp == onThreshold
    horizon: rat(10),
  });
  assert.equal(res.events.length, 2);
  const [on, off] = res.events;
  assert.equal(on!.action, "HEATER_ON");
  assert.equal(on!.time.toString(), "0");
  assert.equal(on!.temperature.toString(), "10");
  assert.equal(on!.reason, "THRESHOLD_REACHED");
  // off threshold 20 would be reached at t=2, but minOn=4 defers the switch
  assert.equal(off!.action, "HEATER_OFF");
  assert.equal(off!.time.toString(), "4");
  assert.equal(off!.temperature.toString(), "30"); // overshoot while locked
  assert.equal(off!.reason, "MIN_INTERVAL_DEFERRED");
  assert.equal(off!.lockedUntil.toString(), "7");
  assert.equal(res.finalState.temp.toString(), "30");
  const report = verify(res);
  assert.ok(report.ok, formatReport(report));
});

// ---------- minimum on/off intervals ----------

test("min off interval: deferred switch with exact gap, then reheat", () => {
  const res = run({
    externalTemp: PiecewiseLinear.fromPairs([[rat(0), rat(24)], [rat(1), rat(0)]]),
    heatingRate: constant(rat(10)),
    minOff: rat(5),
    initial: { t: rat(0), temp: rat(24), heaterOn: true }, // temp == offThreshold
    horizon: rat(20),
  });
  assert.equal(res.events.length, 3);
  const [off, on, off2] = res.events;
  assert.equal(off!.action, "HEATER_OFF");
  assert.equal(off!.time.toString(), "0");
  assert.equal(off!.temperature.toString(), "24");
  // on threshold 18 reached at t=1/4, but minOff=5 defers to t=5
  assert.equal(on!.action, "HEATER_ON");
  assert.equal(on!.time.toString(), "5");
  assert.equal(on!.temperature.toString(), "0");
  assert.equal(on!.reason, "MIN_INTERVAL_DEFERRED");
  assert.equal(off2!.action, "HEATER_OFF");
  assert.equal(off2!.time.toString(), "37/5");
  assert.equal(off2!.temperature.toString(), "24");
  assert.equal(res.finalState.temp.toString(), "24");
  const report = verify(res);
  assert.ok(report.ok, formatReport(report));
});

test("min off interval: dip below threshold during lock does not switch", () => {
  const res = run({
    externalTemp: PiecewiseLinear.fromPairs([
      [rat(0), rat(25)],
      [rat(2), rat(15)],
      [rat(4), rat(25)],
    ]),
    heatingRate: constant(rat(4)),
    minOff: rat(6),
    initial: { t: rat(0), temp: rat(25), heaterOn: true }, // above offThreshold
    horizon: rat(8),
  });
  // Immediate OFF at t=0 (25 >= 24). Temp dips to 15 (< 18) during the lock
  // but recovers to 25 by lock expiry at t=6: no HEATER_ON may occur.
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0]!.action, "HEATER_OFF");
  assert.equal(res.events[0]!.time.toString(), "0");
  assert.equal(res.events[0]!.temperature.toString(), "25");
  assert.equal(res.finalState.temp.toString(), "25");
  assert.equal(res.finalState.heaterOn, false);
  const report = verify(res);
  assert.ok(report.ok, formatReport(report));
});

test("lock expiry exactly on threshold: closed interval in time", () => {
  const res = run({
    externalTemp: PiecewiseLinear.fromPairs([[rat(0), rat(25)], [rat(6), rat(11)]]),
    heatingRate: constant(rat(6)),
    minOff: rat(3),
    initial: { t: rat(0), temp: rat(25), heaterOn: true },
    horizon: rat(6),
  });
  // OFF at t=0 (25 >= 24). Temp hits 18 exactly at lock expiry t=3.
  const [off, on, off2] = res.events;
  assert.equal(off!.action, "HEATER_OFF");
  assert.equal(on!.action, "HEATER_ON");
  assert.equal(on!.time.toString(), "3");
  assert.equal(on!.temperature.toString(), "18"); // exactly onThreshold
  assert.equal(on!.reason, "THRESHOLD_REACHED"); // not deferred: crossing == lock expiry
  assert.equal(off2!.action, "HEATER_OFF");
  assert.equal(off2!.time.toString(), "51/11");
  assert.equal(res.finalState.temp.toString(), "229/11");
  const report = verify(res);
  assert.ok(report.ok, formatReport(report));
});

// ---------- piecewise-linear inputs + full verification ----------

test("piecewise ambient and heating rate: trajectory and independent verification", () => {
  const res = run({
    externalTemp: PiecewiseLinear.fromPairs([
      [rat(0), rat(10)],
      [rat(6), rat(16)],
      [rat(12), rat(4)],
    ]),
    heatingRate: PiecewiseLinear.fromPairs([[rat(0), rat(2)], [rat(12), rat(8)]]),
    onThreshold: rat(8),
    offThreshold: rat(14),
    minOn: rat(1),
    minOff: rat(1),
    initial: { t: rat(0), temp: rat(10), heaterOn: false },
    horizon: rat(12),
  });
  assert.equal(res.events.length, 2);
  const [on, off] = res.events;
  assert.equal(on!.action, "HEATER_ON");
  assert.equal(on!.time.toString(), "10");
  assert.equal(on!.temperature.toString(), "8");
  assert.equal(on!.ambientTemp.toString(), "8"); // ambient equals temp here
  assert.equal(on!.heatingRate.toString(), "7"); // rate sampled at t=10
  assert.equal(off!.action, "HEATER_OFF");
  // minOn=1 locks until t=11; the rate is re-sampled there (15/2), so the
  // slope becomes 11/2 and the crossing lands at 11 + 2/11.
  assert.equal(off!.time.toString(), "123/11");
  assert.equal(off!.temperature.toString(), "14");
  assert.equal(res.finalState.temp.toString(), "136/11");
  const report = verify(res, { subdivisions: 8 });
  assert.ok(report.ok, formatReport(report));
  assert.ok(report.samplesChecked > 0);
});

// ---------- verifier catches tampering ----------

test("verifier rejects a tampered trajectory", () => {
  const res = run({
    externalTemp: PiecewiseLinear.fromPairs([[rat(0), rat(20)], [rat(10), rat(10)]]),
    heatingRate: constant(rat(3)),
    initial: { t: rat(0), temp: rat(20), heaterOn: false },
    horizon: rat(10),
  });
  const tampered: SimulationResult = {
    ...res,
    segments: res.segments.map((s, i) =>
      i === 0 ? { ...s, tempAtTo: s.tempAtTo.add(rat(1)) } : s,
    ),
  };
  const report = verify(tampered);
  assert.ok(!report.ok);
  assert.ok(report.checks.some((c) => !c.ok));
});

// ---------- guard rails ----------

test("invalid configuration is rejected", () => {
  assert.throws(() =>
    run({
      onThreshold: rat(24),
      offThreshold: rat(18), // inverted hysteresis band
      initial: { t: rat(0), temp: rat(20), heaterOn: false },
      horizon: rat(5),
    }),
  );
  assert.throws(() =>
    run({
      initial: { t: rat(0), temp: rat(20), heaterOn: false },
      horizon: rat(0),
    }),
  );
});
