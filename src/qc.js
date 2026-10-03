'use strict';

const FLAG_USABLE = 'usable';
const FLAG_DEGRADED = 'degraded';
const FLAG_BLOCKED = 'blocked';

const DEFAULT_CONFIG = Object.freeze({
  noiseThreshold: 2.0,
  calibQualityThreshold: 0.5,
});

function normalizeConfig(config = {}) {
  return {
    noiseThreshold: config.noiseThreshold ?? DEFAULT_CONFIG.noiseThreshold,
    calibQualityThreshold: config.calibQualityThreshold ?? DEFAULT_CONFIG.calibQualityThreshold,
  };
}

function frameKey(night, frameId) {
  return `${night}|${frameId}`;
}

function calibKey(kind, night, instrument) {
  return `${kind}|${night}|${instrument}`;
}

function compareFrameRef(a, b) {
  if (a.night !== b.night) return a.night < b.night ? -1 : 1;
  if (a.frameId !== b.frameId) return a.frameId < b.frameId ? -1 : 1;
  return 0;
}

function compareNight(a, b) {
  if (a.night !== b.night) return a.night < b.night ? -1 : 1;
  return 0;
}

// Degradation boundaries are exact: a frame is degraded only when
// noise is strictly greater than noiseThreshold, or a calibration
// quality is strictly less than calibQualityThreshold. Equality is usable.
function deriveFrameFlag(frame, ctx, config) {
  const weather = ctx.weather.get(frame.night);
  if (weather && weather.state === 'blocked') return FLAG_BLOCKED;
  const dark = ctx.calibrations.get(calibKey('dark', frame.night, frame.instrument));
  const flat = ctx.calibrations.get(calibKey('flat', frame.night, frame.instrument));
  if (!dark || !flat) return FLAG_BLOCKED;
  if (weather && weather.state === 'degraded') return FLAG_DEGRADED;
  if (frame.metrics.noise > config.noiseThreshold) return FLAG_DEGRADED;
  if (dark.quality < config.calibQualityThreshold) return FLAG_DEGRADED;
  if (flat.quality < config.calibQualityThreshold) return FLAG_DEGRADED;
  return FLAG_USABLE;
}

function summarizeNight(night, flags) {
  const summary = {
    night,
    total: flags.length,
    usable: 0,
    degraded: 0,
    blocked: 0,
    nightFlag: FLAG_USABLE,
  };
  for (const flag of flags) summary[flag] += 1;
  if (flags.length === 0) return summary;
  if (summary.blocked === flags.length) {
    summary.nightFlag = FLAG_BLOCKED;
  } else if (summary.degraded + summary.blocked > 0) {
    summary.nightFlag = FLAG_DEGRADED;
  }
  return summary;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  FLAG_USABLE,
  FLAG_DEGRADED,
  FLAG_BLOCKED,
  DEFAULT_CONFIG,
  normalizeConfig,
  frameKey,
  calibKey,
  compareFrameRef,
  compareNight,
  deriveFrameFlag,
  summarizeNight,
  canonicalize,
};
