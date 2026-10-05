import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.ts";
import { PiecewiseLinear } from "../src/piecewise.ts";
import { simulate, type SimulationResult, type SwitchEvent } from "../src/thermostat.ts";
import { verifySimulation } from "../src/verify.ts";

const R = (n: number, d = 1): Rational => Rational.of(n, d);

function cycleResult(): SimulationResult {
  const external = new PiecewiseLinear([
    { t: R(0), v: R(20) },
    { t: R(60), v: R(-40) },
  ]);
  return simulate({
    external,
    heatingRate: R(3),
    tempOn: R(10),
    tempOff: R(15),
    minOn: R(0),
    minOff: R(0),
    initialState: "off",
    t0: R(0),
    t1: R(40),
  });
}

test("accepts a correct simulation at several subdivision densities", () => {
  const result = cycleResult();
  for (const k of [1, 8, 32]) {
    const report = verifySimulation(result, k);
    assert.ok(report.ok, report.errors.join("\n"));
    assert.ok(report.checks > 0);
  }
});

test("rejects a shifted event time", () => {
  const result = cycleResult();
  const events = result.events.map((e, i) =>
    i === 2 ? { ...e, time: e.time.add(R(1)) } : e,
  );
  const report = verifySimulation({ ...result, events });
  assert.ok(!report.ok);
});

test("rejects a tampered event temperature", () => {
  const result = cycleResult();
  const events = result.events.map((e, i) =>
    i === 0 ? { ...e, temperature: R(11) } : e,
  );
  const report = verifySimulation({ ...result, events });
  assert.ok(!report.ok);
});

test("rejects a removed event (missed switch detected by subdivision)", () => {
  const result = cycleResult();
  const events = result.events.filter((_, i) => i !== 4);
  const report = verifySimulation({ ...result, events });
  assert.ok(!report.ok);
});

test("rejects an appended out-of-horizon event", () => {
  const result = cycleResult();
  const last = result.events[result.events.length - 1];
  const extra: SwitchEvent = {
    ...last,
    index: result.events.length,
    time: R(41),
    from: last.to,
    to: last.from,
  };
  const report = verifySimulation({ ...result, events: [...result.events, extra] });
  assert.ok(!report.ok);
});

test("rejects a tampered crossing time", () => {
  const result = cycleResult();
  const events = result.events.map((e, i) =>
    i === 1 ? { ...e, crossingTime: R(0) } : e,
  );
  const report = verifySimulation({ ...result, events });
  assert.ok(!report.ok);
});

test("rejects a wrong final state", () => {
  const result = cycleResult();
  const report = verifySimulation({
    ...result,
    finalState: result.finalState === "on" ? "off" : "on",
  });
  assert.ok(!report.ok);
});

test("accepts an empty event log when no switch is warranted", () => {
  const external = new PiecewiseLinear([
    { t: R(0), v: R(8) },
    { t: R(3), v: R(5) },
    { t: R(13), v: R(55) },
    { t: R(20), v: R(55) },
  ]);
  const result = simulate({
    external,
    heatingRate: R(4),
    tempOn: R(5),
    tempOff: R(10),
    minOn: R(0),
    minOff: R(10),
    initialState: "off",
    initialTemp: R(8),
    t0: R(0),
    t1: R(20),
  });
  const report = verifySimulation(result, 16);
  assert.ok(report.ok, report.errors.join("\n"));
});
