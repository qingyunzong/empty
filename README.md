# thermostat-sim

Exact thermostat / temperature-control simulation library in TypeScript,
using only Node.js built-in modules (no runtime dependencies).

## Model

- **Piecewise-linear inputs.** The external (ambient) temperature and the
  heating rate are both piecewise-linear functions of time, given as
  breakpoint lists (`src/piecewise.ts`). Outside the breakpoint range they
  are clamped (zero slope).
- **Temperature evolution.** While the heater is OFF the simulated
  temperature tracks the ambient slope. While ON, the heating rate is added;
  it is sampled at the start of each trajectory segment (event time, lock
  expiry, or input breakpoint) and held constant within the segment. The
  simulated temperature is therefore piecewise linear and every event time
  is exactly rational.
- **Hysteresis thresholds.** The heater turns ON when
  `temp <= onThreshold` and OFF when `temp >= offThreshold`
  (`onThreshold < offThreshold`). Thresholds are **closed intervals**:
  reaching a threshold exactly triggers the switch.
- **Minimum on/off intervals.** After switching on, the heater stays on for
  at least `minOn`; after switching off, it stays off for at least `minOff`.
  A threshold crossing during the lock is deferred: the switch happens at
  lock expiry if the condition still holds (event reason
  `MIN_INTERVAL_DEFERRED`), and is dropped if the condition has cleared.
- **Rational event times.** All arithmetic uses exact `BigInt` fractions
  (`src/rational.ts`); event times and temperatures are exact rationals
  such as `123/11`.
- **Switching evidence.** Every switch records time, temperature, action,
  threshold, reason, ambient temperature, heating-rate sample, slopes
  before/after, and the lock-expiry time (`SwitchEvent`).
- **Independent subdivision verification.** `verify()` (`src/verify.ts`)
  re-derives the trajectory from the raw inputs only: each segment is
  subdivided into `k` equal rational sub-intervals, slopes are recomputed
  from the input functions, the temperature is re-integrated from the
  initial condition, and threshold / hysteresis / minimum-interval
  discipline is checked at every sample.

## Usage

```ts
import { rat, PiecewiseLinear, simulate, verify, formatReport } from "./src/index.js";

const result = simulate({
  externalTemp: PiecewiseLinear.fromPairs([[rat(0), rat(10)], [rat(6), rat(16)], [rat(12), rat(4)]]),
  heatingRate:  PiecewiseLinear.fromPairs([[rat(0), rat(2)], [rat(12), rat(8)]]),
  onThreshold: rat(8),
  offThreshold: rat(14),
  minOn: rat(1),
  minOff: rat(1),
  initial: { t: rat(0), temp: rat(10), heaterOn: false },
  horizon: rat(12),
});
console.log(formatReport(verify(result, { subdivisions: 8 })));
```

## Commands

- `npm test` — type-check/compile with `tsc` and run the `node:test` suite.
- `npm run demo` — print switch evidence, segments and the verification
  report for the scenario above.

## Recorded actual results

Environment: Node.js v22.22.1, TypeScript 7.0.2 (global), 2026-10-05.

`npm test` (11 tests, all passing):

```
✔ rational: reduction, sign normalisation, arithmetic
✔ piecewise: exact interpolation, slope, clamping
✔ closed interval: switch exactly when threshold is reached
✔ event times are exact rationals (fractional crossings)
✔ closed interval at t0: initial state exactly on threshold switches immediately
✔ min off interval: deferred switch with exact gap, then reheat
✔ min off interval: dip below threshold during lock does not switch
✔ lock expiry exactly on threshold: closed interval in time
✔ piecewise ambient and heating rate: trajectory and independent verification
✔ verifier rejects a tampered trajectory
✔ invalid configuration is rejected
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

`npm run demo`:

```
== switch events (evidence) ==
#0 t=10 HEATER_ON temp=8 threshold=8 reason=THRESHOLD_REACHED ambient=8 rate=7 slope -2 -> 5 lockedUntil=11
#1 t=123/11 HEATER_OFF temp=14 threshold=14 reason=THRESHOLD_REACHED ambient=62/11 rate=167/22 slope 11/2 -> -2 lockedUntil=134/11

== trajectory segments ==
[0, 6] heater=OFF slope=1 temp 10 -> 16
[6, 10] heater=OFF slope=-2 temp 16 -> 8
[10, 11] heater=ON  slope=5 temp 8 -> 13
[11, 123/11] heater=ON  slope=11/2 temp 13 -> 14
[123/11, 12] heater=OFF slope=-2 temp 14 -> 136/11

final: t=12 temp=136/11 heater=OFF

== independent subdivision verification (k=8) ==
PASS time-coverage: 5 segments tile [0, 12]
PASS segment-slopes: slopes recomputed from inputs match every segment
PASS subdivision-resampling: 40 resampled points match
PASS threshold-discipline: closed-interval thresholds respected at all samples
PASS min-intervals: all on/off gaps satisfy the minimum intervals
PASS event-evidence: 2 switch events carry consistent evidence
PASS final-state: final state matches trajectory end
OK (40 subdivision samples checked)
```

## Layout

- `src/rational.ts` — exact BigInt rational arithmetic.
- `src/piecewise.ts` — piecewise-linear functions of time.
- `src/thermostat.ts` — event-driven simulator (hysteresis + min intervals).
- `src/verify.ts` — independent subdivision verifier.
- `test/thermostat.test.ts` — `node:test` suite.
- `examples/demo.ts` — evidence/report demo.
- `types/node-shim.d.ts` — minimal `node:test` / `node:assert` typings
  (offline environment; replace with `@types/node` when available).
