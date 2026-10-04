// Curve validation and interpolation.
// A curve is a list of points { t, temp, phase, power }:
//   - t:      offset in time units from batch start (first point must be t=0, strictly increasing)
//   - temp:   temperature setpoint at t (linearly interpolated between points)
//   - phase:  'heat' | 'hold' | 'cool' — the phase of the segment STARTING at this point
//   - power:  power demand at t (linearly interpolated between points, 0 after curve end)

export const EPS = 1e-9;

export const PHASES = new Set(['heat', 'hold', 'cool']);

export function validateBatch(batch) {
  const errors = [];
  const push = (code, message) =>
    errors.push({ code, batchId: batch && batch.id !== undefined ? batch.id : null, message });

  if (!batch || typeof batch !== 'object') {
    return [{ code: 'ERR_DOMAIN', batchId: null, message: 'batch must be an object' }];
  }
  if (batch.id === undefined || batch.id === null) push('ERR_DOMAIN', 'missing id');
  if (typeof batch.alloy !== 'string' || batch.alloy.length === 0) {
    push('ERR_DOMAIN', 'missing alloy');
  }
  const band = batch.tempBand;
  if (!Array.isArray(band) || band.length !== 2 || !band.every(Number.isFinite)) {
    push('ERR_DOMAIN', 'tempBand must be [lo, hi] of finite numbers');
  } else if (band[0] > band[1] + EPS) {
    push('ERR_DOMAIN', 'tempBand lo > hi');
  }
  if (!Number.isFinite(batch.load) || batch.load <= 0) {
    push('ERR_DOMAIN', 'load must be a positive finite number');
  }

  const curve = batch.curve;
  if (!Array.isArray(curve) || curve.length === 0) {
    push('ERR_CURVE', 'curve must be a non-empty array of points');
    return errors;
  }
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i] || {};
    if (!Number.isFinite(p.t)) push('ERR_CURVE', `point ${i}: time is not finite`);
    if (!Number.isFinite(p.temp)) push('ERR_CURVE', `point ${i}: temp is not finite`);
    if (!Number.isFinite(p.power)) push('ERR_DOMAIN', `point ${i}: power is not a finite number`);
    else if (p.power < 0) push('ERR_DOMAIN', `point ${i}: negative power`);
    if (i < curve.length - 1 && !PHASES.has(p.phase)) {
      push('ERR_CURVE', `point ${i}: phase must be heat|hold|cool`);
    }
  }
  if (curve.every((p) => p && Number.isFinite(p.t))) {
    if (curve[0].t !== 0) push('ERR_CURVE', 'curve must start at t=0');
    for (let i = 1; i < curve.length; i++) {
      if (!(curve[i].t > curve[i - 1].t)) {
        push('ERR_CURVE', `time inversion between points ${i - 1} and ${i}`);
      }
    }
  }
  // Holding segments must not have a negative slope.
  for (let i = 0; i + 1 < curve.length; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (
      a && b && a.phase === 'hold' &&
      Number.isFinite(a.temp) && Number.isFinite(b.temp) &&
      b.temp < a.temp - EPS
    ) {
      push('ERR_CURVE', `negative-slope hold segment at points ${i}-${i + 1}`);
    }
  }
  return errors;
}

// Compile a valid curve into an interpolator.
export function compileCurve(curve) {
  const duration = curve[curve.length - 1].t;
  const breakpoints = curve.map((p) => p.t);

  function interp(key, t) {
    if (t <= 0) return curve[0][key];
    if (t >= duration) return curve[curve.length - 1][key];
    let lo = 0;
    let hi = curve.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (curve[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = curve[lo];
    const b = curve[hi];
    const f = (t - a.t) / (b.t - a.t);
    return a[key] + (b[key] - a[key]) * f;
  }

  return {
    duration,
    breakpoints,
    tempAt: (t) => interp('temp', t),
    powerAt: (t) => interp('power', t),
  };
}
