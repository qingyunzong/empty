'use strict';

const { Profile } = require('./profile.js');

const SESSION_GAP_MS = 30 * 60 * 1000;
const MIN_DEPTH_M = 0;
const MAX_DEPTH_M = 1000;

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

class Engine {
  constructor({ sessionGapMs = SESSION_GAP_MS } = {}) {
    this.sessionGapMs = sessionGapMs;
    this.profiles = new Map();
    this.published = new Set();
  }

  apply(event) {
    switch (event.type) {
      case 'UPSERT':
        return this.applyUpsert(event);
      case 'RETRACT':
        return this.applyRetract(event);
      case 'WATERMARK':
        return this.applyWatermark(event);
      default:
        throw new Error(`unknown event type: ${String(event.type)}`);
    }
  }

  applyUpsert(event) {
    const { profileId, depth, temp, version } = event;
    const eventTimeMs = toEpochMs(event.eventTime);
    if (this.published.has(profileId)) {
      return { type: 'rejected', reason: 'LATE', profileId, depth, version };
    }
    if (!Number.isInteger(depth) || depth < MIN_DEPTH_M || depth > MAX_DEPTH_M) {
      return { type: 'rejected', reason: 'INVALID_DEPTH', profileId, depth, version };
    }
    let profile = this.profiles.get(profileId);
    if (!profile) {
      profile = new Profile(profileId);
      this.profiles.set(profileId, profile);
    }
    const existing = profile.get(depth);
    if (existing && version <= existing.version) {
      return { type: 'rejected', reason: 'STALE_VERSION', profileId, depth, version };
    }
    profile.upsert(depth, temp, version, eventTimeMs);
    return {
      type: 'upsert',
      status: 'applied',
      profileId,
      depth,
      version,
      inversions: profile.inversionPairList(),
      maxInversionLayer: profile.maxInversionLayer(),
    };
  }

  applyRetract(event) {
    const { profileId, depth, version } = event;
    const eventTimeMs = toEpochMs(event.eventTime);
    if (this.published.has(profileId)) {
      return { type: 'rejected', reason: 'LATE', profileId, depth, version };
    }
    const profile = this.profiles.get(profileId);
    const existing = profile ? profile.get(depth) : undefined;
    if (!existing) {
      return { type: 'rejected', reason: 'UNKNOWN_RETRACT', profileId, depth, version };
    }
    if (version <= existing.version) {
      return { type: 'rejected', reason: 'STALE_VERSION', profileId, depth, version };
    }
    profile.retract(depth, eventTimeMs);
    return {
      type: 'retract',
      status: 'applied',
      profileId,
      depth,
      version,
      inversions: profile.inversionPairList(),
      maxInversionLayer: profile.maxInversionLayer(),
      missing: profile.missingStats(),
    };
  }

  applyWatermark(event) {
    const { profileId } = event;
    const timeMs = toEpochMs(event.time);
    const profile = this.profiles.get(profileId);
    if (!profile || this.published.has(profileId)) return null;
    if (profile.sessionEndMs === null || timeMs <= profile.sessionEndMs + this.sessionGapMs) {
      return null;
    }
    this.published.add(profileId);
    return {
      type: 'certificate',
      profileId,
      sessionStart: new Date(profile.sessionStartMs).toISOString(),
      sessionEnd: new Date(profile.sessionEndMs).toISOString(),
      watermark: new Date(timeMs).toISOString(),
      depths: [...profile.depths],
      inversions: profile.inversionPairList(),
      maxInversionLayer: profile.maxInversionLayer(),
      missing: profile.missingStats(),
    };
  }
}

module.exports = { Engine, SESSION_GAP_MS, MIN_DEPTH_M, MAX_DEPTH_M, toEpochMs };
