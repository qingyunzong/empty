import { Rational } from "./rational.js";
import { PiecewiseLinear, mergeCuts } from "./piecewise.js";

export interface ThermostatConfig {
  /** Piecewise-linear ambient (external) temperature. */
  readonly externalTemp: PiecewiseLinear;
  /**
   * Piecewise-linear heating rate: extra temperature slope contributed
   * while the heater is ON. It is sampled at the start of each trajectory
   * segment (event time, lock expiry, or input breakpoint) and held
   * constant within the segment, so the simulated temperature stays
   * piecewise linear and every event time is exactly rational.
   */
  readonly heatingRate: PiecewiseLinear;
  /** Heater turns ON when temp <= onThreshold (closed interval). */
  readonly onThreshold: Rational;
  /** Heater turns OFF when temp >= offThreshold (closed interval). */
  readonly offThreshold: Rational;
  /** Minimum time the heater must stay ON once switched on. */
  readonly minOn: Rational;
  /** Minimum time the heater must stay OFF once switched off. */
  readonly minOff: Rational;
  readonly initial: { readonly t: Rational; readonly temp: Rational; readonly heaterOn: boolean };
  /** Simulation covers [initial.t, initial.t + horizon]. */
  readonly horizon: Rational;
}

export type HeaterAction = "HEATER_ON" | "HEATER_OFF";

export type SwitchReason = "THRESHOLD_REACHED" | "MIN_INTERVAL_DEFERRED";

/** Evidence recorded for every heater switch. */
export interface SwitchEvent {
  readonly index: number;
  readonly time: Rational;
  readonly temperature: Rational;
  readonly action: HeaterAction;
  readonly threshold: Rational;
  readonly reason: SwitchReason;
  /** Ambient (external) temperature at the switch time. */
  readonly ambientTemp: Rational;
  /** Heating-rate input value at the switch time. */
  readonly heatingRate: Rational;
  /** Temperature slope just before the switch. */
  readonly slopeBefore: Rational;
  /** Temperature slope just after the switch. */
  readonly slopeAfter: Rational;
  /** The heater is locked in its new state until this time. */
  readonly lockedUntil: Rational;
}

/** Maximal run of constant heater state and constant temperature slope. */
export interface TrajectorySegment {
  readonly from: Rational;
  readonly to: Rational;
  readonly heaterOn: boolean;
  readonly slope: Rational;
  readonly tempAtFrom: Rational;
  readonly tempAtTo: Rational;
}

export interface SimulationResult {
  readonly config: ThermostatConfig;
  readonly events: SwitchEvent[];
  readonly segments: TrajectorySegment[];
  readonly finalState: { readonly t: Rational; readonly temp: Rational; readonly heaterOn: boolean };
}

export function simulate(config: ThermostatConfig): SimulationResult {
  const { externalTemp, heatingRate, onThreshold, offThreshold, minOn, minOff, initial, horizon } = config;
  if (!onThreshold.lt(offThreshold)) {
    throw new Error("simulate: onThreshold must be strictly below offThreshold (hysteresis)");
  }
  if (minOn.sign() < 0 || minOff.sign() < 0) {
    throw new Error("simulate: minOn/minOff must be >= 0");
  }
  if (!horizon.gt(Rational.ZERO)) {
    throw new Error("simulate: horizon must be > 0");
  }

  const t0 = initial.t;
  const t1 = t0.add(horizon);
  const cuts = mergeCuts([
    externalTemp.cutPoints(t0, t1),
    heatingRate.cutPoints(t0, t1),
  ]);

  const slopeOf = (at: Rational, heaterOn: boolean): Rational => {
    const ambient = externalTemp.slopeAt(at);
    return heaterOn ? ambient.add(heatingRate.valueAt(at)) : ambient;
  };

  let t = t0;
  let temp = initial.temp;
  let on = initial.heaterOn;
  let lockUntil = t0; // no lock at start: closed-interval switch at t0 is allowed
  let condSince: Rational | null = null;
  let cutIdx = 0;

  const events: SwitchEvent[] = [];
  const segments: TrajectorySegment[] = [];

  let segFrom = t0;
  let segTempFrom = temp;
  let segOn = on;
  let segSlope = slopeOf(t0, on);

  const closeSegment = (u: Rational): void => {
    if (segFrom.lt(u)) {
      segments.push({
        from: segFrom,
        to: u,
        heaterOn: segOn,
        slope: segSlope,
        tempAtFrom: segTempFrom,
        tempAtTo: temp,
      });
    }
    segFrom = u;
    segTempFrom = temp;
    segOn = on;
    segSlope = slopeOf(u, on);
  };

  const switchAt = (at: Rational): void => {
    const action: HeaterAction = on ? "HEATER_OFF" : "HEATER_ON";
    const threshold = on ? offThreshold : onThreshold;
    const reason: SwitchReason =
      condSince !== null && condSince.lt(at) ? "MIN_INTERVAL_DEFERRED" : "THRESHOLD_REACHED";
    const slopeBefore = segSlope;
    closeSegment(at);
    on = !on;
    const slopeAfter = slopeOf(at, on);
    lockUntil = at.add(on ? minOn : minOff);
    events.push({
      index: events.length,
      time: at,
      temperature: temp,
      action,
      threshold,
      reason,
      ambientTemp: externalTemp.valueAt(at),
      heatingRate: heatingRate.valueAt(at),
      slopeBefore,
      slopeAfter,
      lockedUntil: lockUntil,
    });
    segOn = on;
    segSlope = slopeAfter;
    condSince = null;
  };

  while (t.lt(t1)) {
    while (!cuts[cutIdx + 1]!.gt(t)) cutIdx++;
    const pieceEnd = cuts[cutIdx + 1]!;
    const slope = slopeOf(t, on);
    const threshold = on ? offThreshold : onThreshold;
    const cond = on ? temp.ge(offThreshold) : temp.le(onThreshold);

    if (cond) {
      if (condSince === null) condSince = t;
      if (!t.lt(lockUntil)) {
        switchAt(t);
        continue;
      }
    } else {
      condSince = null;
    }

    // Crossing of the relevant threshold inside this piece, if any.
    let crossing: Rational | null = null;
    if (!cond && ((on && slope.sign() > 0) || (!on && slope.sign() < 0))) {
      const tc = t.add(threshold.sub(temp).div(slope));
      if (tc.le(pieceEnd)) crossing = tc;
    }

    const advance = (u: Rational): void => {
      temp = temp.add(slope.mul(u.sub(t)));
      t = u;
    };

    if (t.lt(lockUntil)) {
      // Locked by the minimum on/off interval: only observe for evidence.
      if (crossing !== null && crossing.le(lockUntil)) condSince = crossing;
      const target = pieceEnd.min(lockUntil).min(t1);
      advance(target);
      // The slope is re-sampled from the inputs at the new t, so the
      // current constant-slope segment ends here.
      closeSegment(t);
      continue;
    }

    if (crossing !== null) {
      advance(crossing);
      condSince = t;
      switchAt(t);
      if (t.eq(pieceEnd)) closeSegment(t);
      continue;
    }

    advance(pieceEnd);
    closeSegment(t);
  }
  closeSegment(t1);

  return {
    config,
    events,
    segments,
    finalState: { t, temp, heaterOn: on },
  };
}
