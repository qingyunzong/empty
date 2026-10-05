import { Rational, rat } from "./rational.js";
import { SimulationResult, TrajectorySegment } from "./thermostat.js";

export interface VerificationOptions {
  /** Number of equal subdivisions per trajectory segment (default 8). */
  readonly subdivisions?: number;
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly checks: CheckResult[];
  /** Number of independently resampled (time, temperature) points. */
  readonly samplesChecked: number;
}

/**
 * Independent verification of a simulation result.
 *
 * The trajectory is re-derived from the raw inputs only: every segment is
 * subdivided into k equal rational sub-intervals, the slope is recomputed
 * from the external-temperature / heating-rate functions at each
 * sub-interval midpoint, the temperature is re-integrated from the initial
 * condition, and threshold / hysteresis / minimum-interval discipline is
 * checked at every sample. Nothing is taken on trust from the simulator's
 * recorded temperatures.
 */
export function verify(result: SimulationResult, opts: VerificationOptions = {}): VerificationReport {
  const k = opts.subdivisions ?? 8;
  if (!Number.isInteger(k) || k < 1) throw new Error("verify: subdivisions must be a positive integer");
  const { config, events, segments, finalState } = result;
  const { externalTemp, heatingRate, onThreshold, offThreshold, minOn, minOff, initial, horizon } = config;
  const t0 = initial.t;
  const t1 = t0.add(horizon);

  const checks: CheckResult[] = [];
  let samples = 0;
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // ---- 1. Time coverage: segments tile [t0, t1] without gaps or overlaps.
  {
    let ok = segments.length > 0;
    let detail = "";
    if (ok && !segments[0]!.from.eq(t0)) { ok = false; detail = "first segment does not start at t0"; }
    if (ok && !segments[segments.length - 1]!.to.eq(t1)) { ok = false; detail = "last segment does not end at t1"; }
    for (let i = 0; ok && i < segments.length; i++) {
      const s = segments[i]!;
      if (!s.from.lt(s.to)) { ok = false; detail = `segment ${i} has non-positive duration`; break; }
      if (i > 0 && !segments[i - 1]!.to.eq(s.from)) { ok = false; detail = `gap/overlap before segment ${i}`; break; }
    }
    push("time-coverage", ok, detail || `${segments.length} segments tile [${t0}, ${t1}]`);
  }

  // ---- 2. Atomicity: no input breakpoint strictly inside any segment,
  // ---- and the recorded slope matches a fresh slope computation.
  {
    let ok = true;
    let detail = "";
    for (let i = 0; ok && i < segments.length; i++) {
      const s = segments[i]!;
      for (const bp of externalTemp.points) {
        if (bp.t.gt(s.from) && bp.t.lt(s.to)) { ok = false; detail = `segment ${i} contains external-temp breakpoint ${bp.t}`; break; }
      }
      for (const bp of heatingRate.points) {
        if (bp.t.gt(s.from) && bp.t.lt(s.to)) { ok = false; detail = `segment ${i} contains heating-rate breakpoint ${bp.t}`; break; }
      }
      if (!ok) break;
      const mid = s.from.add(s.to).div(rat(2));
      const expected = externalTemp.slopeAt(mid).add(s.heaterOn ? heatingRate.valueAt(s.from) : Rational.ZERO);
      if (!expected.eq(s.slope)) { ok = false; detail = `segment ${i} slope ${s.slope} != recomputed ${expected}`; break; }
      const wantTo = s.tempAtFrom.add(s.slope.mul(s.to.sub(s.from)));
      if (!wantTo.eq(s.tempAtTo)) { ok = false; detail = `segment ${i} tempAtTo inconsistent with slope`; break; }
    }
    push("segment-slopes", ok, detail || "slopes recomputed from inputs match every segment");
  }

  // ---- 3. Independent subdivision resampling of the temperature.
  // Re-integrate temperature from the initial condition using slopes
  // recomputed from the raw input functions at sub-interval midpoints.
  {
    let ok = true;
    let detail = "";
    let integrated = initial.temp; // running exact integral
    let prevTo = t0;
    for (let i = 0; ok && i < segments.length; i++) {
      const s = segments[i]!;
      if (!s.from.eq(prevTo)) { ok = false; detail = `segment ${i} not contiguous`; break; }
      // recorded tempAtFrom must equal the independently integrated value
      if (!s.tempAtFrom.eq(integrated)) {
        ok = false;
        detail = `segment ${i} starts at ${s.tempAtFrom}, independent integral says ${integrated}`;
        break;
      }
      const dur = s.to.sub(s.from);
      for (let j = 1; ok && j <= k; j++) {
        const tau = s.from.add(dur.mul(rat(j, k)));
        const mid = s.from.add(dur.mul(rat(2 * j - 1, 2 * k)));
        const slope = externalTemp.slopeAt(mid).add(s.heaterOn ? heatingRate.valueAt(s.from) : Rational.ZERO);
        integrated = integrated.add(slope.mul(dur.div(rat(k))));
        samples++;
        const recorded = s.tempAtFrom.add(s.slope.mul(tau.sub(s.from)));
        if (!integrated.eq(recorded)) {
          ok = false;
          detail = `segment ${i} sample ${j}/${k} at t=${tau}: integrated ${integrated} != recorded ${recorded}`;
        }
      }
      if (ok && !integrated.eq(s.tempAtTo)) {
        ok = false;
        detail = `segment ${i} ends at ${s.tempAtTo}, independent integral says ${integrated}`;
      }
      prevTo = s.to;
    }
    if (ok && !integrated.eq(finalState.temp)) {
      ok = false;
      detail = `final temp ${finalState.temp} != independent integral ${integrated}`;
    }
    push("subdivision-resampling", ok, detail || `${samples} resampled points match`);
  }

  // ---- 4. Threshold discipline at every resampled point (lock-aware).
  {
    // Map event times for quick lookup.
    const offAt = new Map<string, Rational>();
    const onAt = new Map<string, Rational>();
    for (const e of events) {
      (e.action === "HEATER_OFF" ? offAt : onAt).set(e.time.toString(), e.time);
    }
    let ok = true;
    let detail = "";
    // Track the lock window from events.
    let lockEnd = t0;
    let evIdx = 0;
    for (let i = 0; ok && i < segments.length; i++) {
      const s = segments[i]!;
      while (evIdx < events.length && events[evIdx]!.time.le(s.from)) {
        const e = events[evIdx]!;
        lockEnd = e.time.add(e.action === "HEATER_ON" ? minOn : minOff);
        evIdx++;
      }
      const dur = s.to.sub(s.from);
      for (let j = 0; ok && j <= k; j++) {
        const tau = s.from.add(dur.mul(rat(j, k)));
        if (tau.le(lockEnd)) continue; // inside min-interval lock: no constraint
        const temp = s.tempAtFrom.add(s.slope.mul(tau.sub(s.from)));
        if (s.heaterOn) {
          if (temp.gt(offThreshold)) { ok = false; detail = `t=${tau}: heater ON but temp ${temp} > off threshold ${offThreshold}`; }
          else if (temp.eq(offThreshold) && !offAt.has(tau.toString())) { ok = false; detail = `t=${tau}: temp exactly at off threshold but no HEATER_OFF event`; }
        } else {
          if (temp.lt(onThreshold)) { ok = false; detail = `t=${tau}: heater OFF but temp ${temp} < on threshold ${onThreshold}`; }
          else if (temp.eq(onThreshold) && !onAt.has(tau.toString())) { ok = false; detail = `t=${tau}: temp exactly at on threshold but no HEATER_ON event`; }
        }
      }
    }
    push("threshold-discipline", ok, detail || "closed-interval thresholds respected at all samples");
  }

  // ---- 5. Minimum on/off intervals between consecutive events.
  {
    let ok = true;
    let detail = "";
    for (let i = 1; ok && i < events.length; i++) {
      const prev = events[i - 1]!;
      const cur = events[i]!;
      const gap = cur.time.sub(prev.time);
      if (prev.action === "HEATER_ON" && gap.lt(minOn)) {
        ok = false; detail = `event ${i}: ON->OFF gap ${gap} < minOn ${minOn}`;
      } else if (prev.action === "HEATER_OFF" && gap.lt(minOff)) {
        ok = false; detail = `event ${i}: OFF->ON gap ${gap} < minOff ${minOff}`;
      }
    }
    push("min-intervals", ok, detail || "all on/off gaps satisfy the minimum intervals");
  }

  // ---- 6. Event evidence internal consistency.
  {
    let ok = events.length === 0 || events[0]!.action === (initial.heaterOn ? "HEATER_OFF" : "HEATER_ON");
    let detail = ok ? "" : "first event does not flip the initial heater state";
    for (let i = 0; ok && i < events.length; i++) {
      const e = events[i]!;
      if (i > 0 && events[i - 1]!.action === e.action) { ok = false; detail = `event ${i} repeats previous action`; break; }
      if (e.time.lt(t0) || e.time.gt(t1)) { ok = false; detail = `event ${i} outside horizon`; break; }
      if (e.action === "HEATER_OFF" && e.temperature.lt(offThreshold)) { ok = false; detail = `event ${i}: OFF below off threshold`; break; }
      if (e.action === "HEATER_ON" && e.temperature.gt(onThreshold)) { ok = false; detail = `event ${i}: ON above on threshold`; break; }
      if (
        e.reason === "THRESHOLD_REACHED" &&
        !e.temperature.eq(e.threshold) &&
        !(i === 0 && e.time.eq(t0)) // initial state may start beyond the threshold
      ) {
        ok = false; detail = `event ${i}: THRESHOLD_REACHED but temp ${e.temperature} != threshold ${e.threshold}`; break;
      }
      if (e.reason === "MIN_INTERVAL_DEFERRED") {
        if (i === 0) { ok = false; detail = "event 0 cannot be deferred"; break; }
        const prev = events[i - 1]!;
        const want = prev.time.add(prev.action === "HEATER_ON" ? minOn : minOff);
        if (!e.time.eq(want)) { ok = false; detail = `event ${i}: deferred switch at ${e.time}, lock expired at ${want}`; break; }
      }
      if (!e.lockedUntil.eq(e.time.add(e.action === "HEATER_ON" ? minOn : minOff))) {
        ok = false; detail = `event ${i}: lockedUntil inconsistent`; break;
      }
    }
    push("event-evidence", ok, detail || `${events.length} switch events carry consistent evidence`);
  }

  // ---- 7. Final state.
  {
    let ok = finalState.t.eq(t1);
    let detail = ok ? "" : `final t ${finalState.t} != ${t1}`;
    if (ok && segments.length > 0) {
      const last = segments[segments.length - 1]!;
      if (!finalState.temp.eq(last.tempAtTo)) { ok = false; detail = "final temp mismatch"; }
      else if (finalState.heaterOn !== last.heaterOn) { ok = false; detail = "final heater state mismatch"; }
    }
    push("final-state", ok, detail || "final state matches trajectory end");
  }

  return { ok: checks.every((c) => c.ok), checks, samplesChecked: samples };
}

/** Human-readable rendering of a verification report. */
export function formatReport(report: VerificationReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  }
  lines.push(`${report.ok ? "OK" : "FAILED"} (${report.samplesChecked} subdivision samples checked)`);
  return lines.join("\n");
}

export type { TrajectorySegment };
