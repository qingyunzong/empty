import { Rational } from "./rational.ts";
import { PiecewiseLinear } from "./piecewise.ts";
import { simulate } from "./thermostat.ts";
import { verifySimulation } from "./verify.ts";

const R = (n: number, d = 1): Rational => Rational.of(n, d);

const external = new PiecewiseLinear([
  { t: R(0), v: R(14) },
  { t: R(6), v: R(8) },
  { t: R(12), v: R(20) },
  { t: R(18), v: R(4) },
  { t: R(24), v: R(10) },
  { t: R(30), v: R(10) },
]);

const result = simulate({
  external,
  heatingRate: R(3),
  tempOn: R(18),
  tempOff: R(22),
  minOn: R(2),
  minOff: R(3),
  initialState: "off",
  t0: R(0),
  t1: R(30),
});

const pad = (s: string, w: number): string => s.padStart(w);
const header = ["idx", "switch", "time", "temp", "threshold", "crossing", "deferred", "minReq", "sincePrev", "slopeBefore", "slopeAfter"];
console.log(header.map((h) => pad(h, 11)).join(""));
for (const e of result.events) {
  const row = [
    String(e.index),
    `${e.from}->${e.to}`,
    e.time.toString(),
    e.temperature.toString(),
    e.threshold.toString(),
    e.crossingTime.toString(),
    String(e.deferred),
    e.minIntervalRequired.toString(),
    e.sincePreviousSwitch.toString(),
    e.slopeBefore.toString(),
    e.slopeAfter.toString(),
  ];
  console.log(row.map((c) => pad(c, 11)).join(""));
}
console.log(`final: state=${result.finalState} temp=${result.finalTemp} at t=${result.config.t1}`);

const report = verifySimulation(result, 16);
console.log(
  `verification: ok=${report.ok} checks=${report.checks} subdivisions=${report.subdivisions}`,
);
if (!report.ok) {
  for (const err of report.errors) console.log(`  ERROR: ${err}`);
  process.exitCode = 1;
}
