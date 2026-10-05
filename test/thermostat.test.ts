import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.ts";
import { PiecewiseLinear } from "../src/piecewise.ts";
import { simulate, temperatureAt, type ThermostatConfig } from "../src/thermostat.ts";
import { verifySimulation } from "../src/verify.ts";

const R = (n: number, d = 1): Rational => Rational.of(n, d);

const constant = (v: number, span = 100): PiecewiseLinear =>
  new PiecewiseLinear([
    { t: R(0), v: R(v) },
    { t: R(span), v: R(v) },
  ]);

const base: Omit<ThermostatConfig, "external"> = {
  heatingRate: R(2),
  tempOn: R(5),
  tempOff: R(9),
  minOn: R(0),
  minOff: R(0),
  initialState: "off",
  t0: R(0),
  t1: R(10),
};

test("closed interval: exact threshold reach triggers, min-off defers switch-on", () => {
  const result = simulate({
    ...base,
    external: constant(0),
    minOff: R(3),
    initialTemp: R(5),
  });
  assert.equal(result.events.length, 2);

  const on = result.events[0];
  assert.equal(on.to, "on");
  assert.equal(on.time.toString(), "3");
  assert.equal(on.temperature.toString(), "5");
  assert.equal(on.crossingTime.toString(), "0");
  assert.equal(on.deferred, true);
  assert.equal(on.minIntervalRequired.toString(), "3");

  const off = result.events[1];
  assert.equal(off.to, "off");
  assert.equal(off.time.toString(), "5");
  assert.equal(off.temperature.toString(), "9");
  assert.equal(off.crossingTime.toString(), "5");
  assert.equal(off.deferred, false);

  assert.ok(verifySimulation(result).ok);
});

test("limit cycle with exact rational event times, including one at the horizon end", () => {
  const external = new PiecewiseLinear([
    { t: R(0), v: R(20) },
    { t: R(60), v: R(-40) },
  ]);
  const result = simulate({
    ...base,
    external,
    heatingRate: R(3),
    tempOn: R(10),
    tempOff: R(15),
    t1: R(40),
  });
  const got = result.events.map((e) => [e.time.toString(), e.temperature.toString(), e.to]);
  assert.deepEqual(got, [
    ["10", "10", "on"],
    ["25/2", "15", "off"],
    ["35/2", "10", "on"],
    ["20", "15", "off"],
    ["25", "10", "on"],
    ["55/2", "15", "off"],
    ["65/2", "10", "on"],
    ["35", "15", "off"],
    ["40", "10", "on"],
  ]);

  const first = result.events[0];
  assert.equal(first.sincePreviousSwitch.toString(), "10");
  assert.equal(first.slopeBefore.toString(), "-1");
  assert.equal(first.slopeAfter.toString(), "2");
  assert.equal(first.segmentIndex, 0);

  assert.equal(result.finalState, "on");
  assert.equal(result.finalTemp.toString(), "10");
  assert.ok(verifySimulation(result).ok);
});

test("min-on defers switch-off; evidence records the earlier crossing", () => {
  const result = simulate({
    ...base,
    external: constant(0, 50),
    heatingRate: R(10),
    tempOn: R(5),
    tempOff: R(6),
    minOn: R(10),
    initialTemp: R(4),
    t1: R(50),
  });
  assert.equal(result.events.length, 2);

  const on = result.events[0];
  assert.equal(on.time.toString(), "0");
  assert.equal(on.temperature.toString(), "4");
  assert.equal(on.deferred, false);

  const off = result.events[1];
  assert.equal(off.time.toString(), "10");
  assert.equal(off.temperature.toString(), "104");
  assert.equal(off.crossingTime.toString(), "1/5");
  assert.equal(off.deferred, true);
  assert.equal(off.sincePreviousSwitch.toString(), "10");

  assert.ok(verifySimulation(result).ok);
});

test("threshold touch inside forbidden window followed by recovery yields no switch", () => {
  const external = new PiecewiseLinear([
    { t: R(0), v: R(8) },
    { t: R(3), v: R(5) },
    { t: R(13), v: R(55) },
    { t: R(20), v: R(55) },
  ]);
  const result = simulate({
    ...base,
    external,
    heatingRate: R(4),
    tempOn: R(5),
    tempOff: R(10),
    minOff: R(10),
    initialTemp: R(8),
    t1: R(20),
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.finalState, "off");
  assert.equal(result.finalTemp.toString(), "55");
  assert.ok(verifySimulation(result).ok);
});

test("exact threshold hit at an external-temperature breakpoint", () => {
  const external = new PiecewiseLinear([
    { t: R(0), v: R(10) },
    { t: R(4), v: R(6) },
    { t: R(20), v: R(6) },
  ]);
  const result = simulate({
    ...base,
    external,
    tempOn: R(6),
    tempOff: R(9),
    initialTemp: R(10),
    t1: R(20),
  });
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].time.toString(), "4");
  assert.equal(result.events[0].temperature.toString(), "6");
  assert.equal(result.events[0].segmentIndex, 1);
  assert.equal(result.events[1].time.toString(), "11/2");
  assert.equal(result.events[1].temperature.toString(), "9");
  assert.ok(verifySimulation(result).ok);
});

test("temperatureAt reconstructs the trajectory consistently", () => {
  const external = new PiecewiseLinear([
    { t: R(0), v: R(20) },
    { t: R(60), v: R(-40) },
  ]);
  const config: ThermostatConfig = {
    ...base,
    external,
    heatingRate: R(3),
    tempOn: R(10),
    tempOff: R(15),
    t1: R(40),
  };
  const result = simulate(config);
  assert.equal(temperatureAt(config, result.events, R(11)).toString(), "12");
  assert.equal(temperatureAt(config, result.events, R(15)).toString(), "25/2");
  assert.equal(temperatureAt(config, result.events, R(40)).toString(), "10");
});

test("invalid configs are rejected", () => {
  assert.throws(() =>
    simulate({ ...base, external: constant(0), tempOn: R(9), tempOff: R(5) }),
  );
  assert.throws(() =>
    simulate({ ...base, external: constant(0), heatingRate: R(0) }),
  );
  assert.throws(() =>
    simulate({ ...base, external: constant(0), t0: R(5), t1: R(5) }),
  );
});
