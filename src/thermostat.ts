import { Rational } from "./rational.ts";
import type { PiecewiseLinear } from "./piecewise.ts";

export type HeaterState = "on" | "off";

export interface ThermostatConfig {
  readonly external: PiecewiseLinear;
  readonly heatingRate: Rational;
  readonly tempOn: Rational;
  readonly tempOff: Rational;
  readonly minOn: Rational;
  readonly minOff: Rational;
  readonly initialState: HeaterState;
  readonly initialTemp?: Rational;
  readonly t0: Rational;
  readonly t1: Rational;
}

export interface SwitchEvent {
  readonly index: number;
  readonly time: Rational;
  readonly temperature: Rational;
  readonly from: HeaterState;
  readonly to: HeaterState;
  readonly threshold: Rational;
  readonly crossingTime: Rational;
  readonly deferred: boolean;
  readonly minIntervalRequired: Rational;
  readonly sincePreviousSwitch: Rational;
  readonly slopeBefore: Rational;
  readonly slopeAfter: Rational;
  readonly segmentIndex: number;
}

export interface SimulationResult {
  readonly config: ThermostatConfig;
  readonly events: SwitchEvent[];
  readonly finalTemp: Rational;
  readonly finalState: HeaterState;
}

export function validateConfig(config: ThermostatConfig): void {
  if (!config.tempOn.lt(config.tempOff)) {
    throw new Error("tempOn must be strictly below tempOff (hysteresis)");
  }
  if (config.minOn.sign() < 0 || config.minOff.sign() < 0) {
    throw new Error("minOn/minOff must be non-negative");
  }
  if (config.heatingRate.sign() <= 0) {
    throw new Error("heatingRate must be positive");
  }
  if (!config.t0.lt(config.t1)) {
    throw new Error("t0 must be strictly before t1");
  }
}

function thresholdFor(config: ThermostatConfig, state: HeaterState): Rational {
  return state === "on" ? config.tempOff : config.tempOn;
}

function conditionHolds(config: ThermostatConfig, state: HeaterState, temp: Rational): boolean {
  return state === "on" ? temp.ge(config.tempOff) : temp.le(config.tempOn);
}

function slopeWith(config: ThermostatConfig, state: HeaterState, base: Rational): Rational {
  return state === "on" ? base.add(config.heatingRate) : base;
}

function findCrossingTime(
  config: ThermostatConfig,
  state: HeaterState,
  stateStart: Rational,
  stateStartTemp: Rational,
  switchTime: Rational,
): Rational {
  const bounds: Rational[] = [stateStart];
  let bp = config.external.nextBreakpointAfter(stateStart);
  while (bp !== null && bp.lt(switchTime)) {
    bounds.push(bp);
    bp = config.external.nextBreakpointAfter(bp);
  }
  bounds.push(switchTime);

  const temps: Rational[] = [stateStartTemp];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const slope = slopeWith(config, state, config.external.slopeAt(bounds[i]));
    temps.push(temps[i].add(slope.mul(bounds[i + 1].sub(bounds[i]))));
  }

  for (let i = bounds.length - 1; i > 0; i--) {
    const a = bounds[i - 1];
    const b = bounds[i];
    const tempA = temps[i - 1];
    const tempB = temps[i];
    if (!conditionHolds(config, state, tempB)) {
      throw new Error("internal error: trigger condition must hold at switch time");
    }
    if (conditionHolds(config, state, tempA)) continue;
    const slope = tempB.sub(tempA).div(b.sub(a));
    return a.add(thresholdFor(config, state).sub(tempA).div(slope));
  }
  return stateStart;
}

export function simulate(config: ThermostatConfig): SimulationResult {
  validateConfig(config);
  const events: SwitchEvent[] = [];
  let state: HeaterState = config.initialState;
  let t = config.t0;
  let temp = config.initialTemp ?? config.external.valueAt(t);
  let lastSwitch = t;
  let stateStart = t;
  let stateStartTemp = temp;

  while (t.lt(config.t1)) {
    const nextBp = config.external.nextBreakpointAfter(t);
    const segEnd = nextBp !== null && nextBp.lt(config.t1) ? nextBp : config.t1;
    const slope = slopeWith(config, state, config.external.slopeAt(t));
    const allow = lastSwitch.add(state === "on" ? config.minOn : config.minOff);
    const start = Rational.max(t, allow);
    const threshold = thresholdFor(config, state);

    let switchTime: Rational | null = null;
    if (start.le(segEnd)) {
      const tempAtStart = temp.add(slope.mul(start.sub(t)));
      if (conditionHolds(config, state, tempAtStart)) {
        switchTime = start;
      } else if (!slope.isZero()) {
        const cross = t.add(threshold.sub(temp).div(slope));
        if (cross.gt(start) && cross.le(segEnd)) switchTime = cross;
      }
    }

    if (switchTime !== null) {
      const switchTemp = temp.add(slope.mul(switchTime.sub(t)));
      const crossing = findCrossingTime(config, state, stateStart, stateStartTemp, switchTime);
      const required = state === "on" ? config.minOn : config.minOff;
      const newState: HeaterState = state === "on" ? "off" : "on";
      events.push({
        index: events.length,
        time: switchTime,
        temperature: switchTemp,
        from: state,
        to: newState,
        threshold,
        crossingTime: crossing,
        deferred: crossing.lt(switchTime),
        minIntervalRequired: required,
        sincePreviousSwitch: switchTime.sub(lastSwitch),
        slopeBefore: slope,
        slopeAfter: slopeWith(config, newState, config.external.slopeAt(switchTime)),
        segmentIndex: config.external.segmentIndexAt(switchTime),
      });
      state = newState;
      t = switchTime;
      temp = switchTemp;
      lastSwitch = switchTime;
      stateStart = switchTime;
      stateStartTemp = switchTemp;
    } else {
      temp = temp.add(slope.mul(segEnd.sub(t)));
      t = segEnd;
    }
  }

  return { config, events, finalTemp: temp, finalState: state };
}

export function temperatureAt(
  config: ThermostatConfig,
  events: readonly SwitchEvent[],
  time: Rational,
): Rational {
  let t = config.t0;
  let temp = config.initialTemp ?? config.external.valueAt(t);
  let state: HeaterState = config.initialState;
  const advance = (target: Rational): void => {
    while (t.lt(target)) {
      const bp = config.external.nextBreakpointAfter(t);
      const stop = bp !== null && bp.lt(target) ? bp : target;
      const slope = slopeWith(config, state, config.external.slopeAt(t));
      temp = temp.add(slope.mul(stop.sub(t)));
      t = stop;
    }
  };
  for (const e of events) {
    if (e.time.gt(time)) break;
    advance(e.time);
    state = e.to;
  }
  advance(time);
  return temp;
}
