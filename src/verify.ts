import { Rational } from "./rational.ts";
import type { HeaterState, SimulationResult, ThermostatConfig } from "./thermostat.ts";

export interface VerificationReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly checks: number;
  readonly subdivisions: number;
}

export function verifySimulation(result: SimulationResult, subdivisions = 8): VerificationReport {
  const config: ThermostatConfig = result.config;
  const events = result.events;
  const errors: string[] = [];
  let checks = 0;
  const zero = Rational.of(0);

  const check = (cond: boolean, message: string): void => {
    checks += 1;
    if (!cond) errors.push(message);
  };

  const stateAfter = (time: Rational): HeaterState => {
    let s = config.initialState;
    for (const e of events) {
      if (e.time.le(time)) s = e.to;
      else break;
    }
    return s;
  };

  const leftSlopeAt = (t: Rational): Rational => {
    const pts = config.external.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (pts[i + 1].t.equals(t)) return config.external.slopeOfSegment(i);
    }
    return config.external.slopeAt(t);
  };

  const tempAt = (time: Rational): Rational => {
    let temp = config.initialTemp ?? config.external.valueAt(config.t0);
    let cursor = config.t0;
    const cuts: Rational[] = [];
    let bp = config.external.nextBreakpointAfter(config.t0);
    while (bp !== null && bp.lt(time)) {
      cuts.push(bp);
      bp = config.external.nextBreakpointAfter(bp);
    }
    for (const e of events) {
      if (e.time.gt(config.t0) && e.time.lt(time)) cuts.push(e.time);
    }
    cuts.sort((a, b) => a.cmp(b));
    let state: HeaterState = stateAfter(config.t0);
    for (const cut of cuts) {
      if (cut.le(cursor)) {
        state = stateAfter(cut);
        continue;
      }
      const slope = config.external
        .slopeAt(cursor)
        .add(state === "on" ? config.heatingRate : zero);
      temp = temp.add(slope.mul(cut.sub(cursor)));
      cursor = cut;
      state = stateAfter(cut);
    }
    const slope = config.external
      .slopeAt(cursor)
      .add(state === "on" ? config.heatingRate : zero);
    return temp.add(slope.mul(time.sub(cursor)));
  };

  check(Number.isInteger(subdivisions) && subdivisions >= 1, "subdivisions must be a positive integer");
  check(config.tempOn.lt(config.tempOff), "config: tempOn must be below tempOff");
  check(config.minOn.sign() >= 0 && config.minOff.sign() >= 0, "config: negative min interval");
  check(config.t0.lt(config.t1), "config: empty horizon");

  let expectedFrom: HeaterState = config.initialState;
  let previousTime: Rational | null = null;
  events.forEach((e, i) => {
    check(e.index === i, `event ${i}: index field is ${e.index}`);
    check(e.from === expectedFrom, `event ${i}: from=${e.from}, expected ${expectedFrom}`);
    check(
      e.to === (expectedFrom === "on" ? "off" : "on"),
      `event ${i}: to=${e.to} does not toggle ${expectedFrom}`,
    );
    if (previousTime !== null) {
      check(previousTime.lt(e.time), `event ${i}: time ${e.time} not strictly increasing`);
    }
    check(
      config.t0.le(e.time) && e.time.le(config.t1),
      `event ${i}: time ${e.time} outside [${config.t0}, ${config.t1}]`,
    );
    expectedFrom = e.to;
    previousTime = e.time;
  });

  events.forEach((e, i) => {
    const prevSwitch = i === 0 ? config.t0 : events[i - 1].time;
    const required = e.from === "on" ? config.minOn : config.minOff;
    const allow = prevSwitch.add(required);
    const threshold = e.from === "on" ? config.tempOff : config.tempOn;

    check(e.minIntervalRequired.equals(required), `event ${i}: wrong minIntervalRequired`);
    check(
      e.sincePreviousSwitch.equals(e.time.sub(prevSwitch)),
      `event ${i}: sincePreviousSwitch inconsistent`,
    );
    check(
      e.sincePreviousSwitch.ge(required),
      `event ${i}: min ${e.from} interval violated (${e.sincePreviousSwitch} < ${required})`,
    );
    check(e.threshold.equals(threshold), `event ${i}: wrong threshold recorded`);

    const holdsAtSwitch =
      e.from === "on" ? e.temperature.ge(config.tempOff) : e.temperature.le(config.tempOn);
    check(holdsAtSwitch, `event ${i}: trigger condition not satisfied at switch time`);
    check(
      tempAt(e.time).equals(e.temperature),
      `event ${i}: recorded temperature ${e.temperature} != reconstructed ${tempAt(e.time)}`,
    );
    check(
      e.segmentIndex === config.external.segmentIndexAt(e.time),
      `event ${i}: wrong segmentIndex`,
    );
    check(
      e.slopeBefore.equals(
        leftSlopeAt(e.time).add(e.from === "on" ? config.heatingRate : zero),
      ),
      `event ${i}: slopeBefore inconsistent`,
    );
    check(
      e.slopeAfter.equals(
        config.external.slopeAt(e.time).add(e.to === "on" ? config.heatingRate : zero),
      ),
      `event ${i}: slopeAfter inconsistent`,
    );

    check(
      prevSwitch.le(e.crossingTime) && e.crossingTime.le(e.time),
      `event ${i}: crossingTime ${e.crossingTime} out of range`,
    );
    const crossTemp = tempAt(e.crossingTime);
    const holdsAtCrossing =
      e.from === "on" ? crossTemp.ge(config.tempOff) : crossTemp.le(config.tempOn);
    check(holdsAtCrossing, `event ${i}: condition does not hold at recorded crossingTime`);
    if (e.crossingTime.gt(prevSwitch)) {
      check(
        crossTemp.equals(threshold),
        `event ${i}: crossing temperature ${crossTemp} is not exactly threshold ${threshold}`,
      );
    }
    check(
      e.time.equals(Rational.max(e.crossingTime, allow)),
      `event ${i}: switch time ${e.time} != max(crossing ${e.crossingTime}, earliest allowed ${allow})`,
    );
    check(
      e.deferred === e.crossingTime.lt(e.time),
      `event ${i}: deferred flag inconsistent with crossingTime`,
    );
  });

  const boundaries: Rational[] = [config.t0, ...events.map((e) => e.time), config.t1];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    if (a.equals(b)) continue;
    const state = stateAfter(a);
    const required = state === "on" ? config.minOn : config.minOff;
    const allow = a.add(required);
    const isLast = i + 1 === boundaries.length - 1;
    const top = isLast ? subdivisions : subdivisions - 1;
    for (let j = 0; j <= top; j++) {
      const tau = a.add(b.sub(a).mul(Rational.of(j, subdivisions)));
      if (tau.lt(allow)) continue;
      const temp = tempAt(tau);
      const holds = state === "on" ? temp.ge(config.tempOff) : temp.le(config.tempOn);
      check(
        !holds,
        `missed switch: ${state}-state trigger condition holds at t=${tau} inside [${a}, ${b}] while switching was allowed`,
      );
    }
  }

  check(result.finalState === stateAfter(config.t1), "finalState mismatch with event log");
  check(
    tempAt(config.t1).equals(result.finalTemp),
    `finalTemp ${result.finalTemp} != reconstructed ${tempAt(config.t1)}`,
  );

  return { ok: errors.length === 0, errors, checks, subdivisions };
}
