'use strict';

const DEFAULT_THRESHOLD = 10;

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function normalizeConfig(config = {}) {
  const threshold = typeof config.threshold === 'number' ? config.threshold : DEFAULT_THRESHOLD;
  return { threshold };
}

function normalizeState(state = {}) {
  const frames = {};
  const raw = state.frames || [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  for (const f of list) {
    frames[f.id] = { id: f.id, night: f.night, instrument: f.instrument, signal: f.signal };
  }
  return {
    frames,
    calibrations: structuredClone(state.calibrations || {}),
    weather: structuredClone(state.weather || {}),
  };
}

function calibrationMissing(calibration) {
  return (
    !calibration ||
    typeof calibration.dark !== 'number' ||
    typeof calibration.flat !== 'number'
  );
}

function frameScore(frame, calibration, weather) {
  const attenuation = weather && typeof weather.attenuation === 'number' ? weather.attenuation : 1;
  return (frame.signal - calibration.dark) * calibration.flat * attenuation;
}

// Flag rules (exact boundary semantics):
//   blocked   - dark/flat calibration missing, or weather status is "blocked"
//   degraded  - score < threshold (strict; score === threshold is usable)
//   usable    - otherwise
function frameFlag(frame, calibration, weather, threshold) {
  if (calibrationMissing(calibration)) return 'blocked';
  if (weather && weather.status === 'blocked') return 'blocked';
  return frameScore(frame, calibration, weather) < threshold ? 'degraded' : 'usable';
}

function summarize(night, flags) {
  const counts = { usable: 0, degraded: 0, blocked: 0 };
  for (const flag of flags) counts[flag] += 1;
  const total = flags.length;
  let status = 'empty';
  if (counts.blocked > 0) status = 'blocked';
  else if (counts.degraded > 0) status = 'degraded';
  else if (total > 0) status = 'usable';
  return {
    night,
    total,
    usable: counts.usable,
    degraded: counts.degraded,
    blocked: counts.blocked,
    status,
  };
}

// Full-enumeration QC: recompute every frame flag and every night summary.
function computeDerived(state, config) {
  const frames = Object.values(state.frames).sort(
    (a, b) => cmpStr(a.night, b.night) || cmpStr(a.id, b.id)
  );
  const flags = {};
  const byNight = new Map();
  for (const frame of frames) {
    const flag = frameFlag(
      frame,
      state.calibrations[frame.instrument],
      state.weather[frame.night],
      config.threshold
    );
    flags[frame.id] = flag;
    if (!byNight.has(frame.night)) byNight.set(frame.night, []);
    byNight.get(frame.night).push(flag);
  }
  const summaries = {};
  for (const night of [...byNight.keys()].sort(cmpStr)) {
    summaries[night] = summarize(night, byNight.get(night));
  }
  return { flags, summaries };
}

module.exports = {
  DEFAULT_THRESHOLD,
  cmpStr,
  canonical,
  normalizeConfig,
  normalizeState,
  calibrationMissing,
  frameScore,
  frameFlag,
  summarize,
  computeDerived,
};
