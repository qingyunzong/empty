'use strict';

const { Profile, ProfileError, isValidDepth } = require('./profile');

const SESSION_GAP_MS = 30 * 60 * 1000;

function parseTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

class Engine {
  constructor({ sessionGapMs = SESSION_GAP_MS } = {}) {
    this.sessionGapMs = sessionGapMs;
    this.profiles = new Map(); // profileId -> Profile
  }

  apply(event) {
    const outputs = [];
    const errors = [];
    try {
      switch (event && event.type) {
        case 'UPSERT':
          outputs.push(this._upsert(event));
          break;
        case 'RETRACT':
          outputs.push(this._retract(event));
          break;
        case 'WATERMARK':
          outputs.push(...this._watermark(event));
          break;
        default:
          throw new ProfileError(
            'UNKNOWN_TYPE',
            `unknown event type: ${event && event.type}`
          );
      }
    } catch (err) {
      if (err instanceof ProfileError) {
        errors.push({ type: 'ERROR', code: err.code, message: err.message, event });
      } else {
        throw err;
      }
    }
    return { outputs, errors };
  }

  _common(event) {
    if (typeof event.profileId !== 'string' || event.profileId.length === 0) {
      throw new ProfileError('INVALID_EVENT', 'profileId must be a non-empty string');
    }
    const timeMs = parseTimeMs(event.time);
    if (timeMs === null) {
      throw new ProfileError('INVALID_EVENT', `unparseable time: ${event.time}`);
    }
    if (typeof event.version !== 'number' || !Number.isFinite(event.version)) {
      throw new ProfileError('INVALID_EVENT', 'version must be a finite number');
    }
    return timeMs;
  }

  _liveProfile(profileId) {
    const profile = this.profiles.get(profileId);
    if (profile && profile.closed) {
      throw new ProfileError(
        'LATE',
        `profile ${profileId} is closed; certificate already published`
      );
    }
    return profile;
  }

  _upsert(event) {
    const timeMs = this._common(event);
    if (!isValidDepth(event.depth)) {
      throw new ProfileError(
        'INVALID_DEPTH',
        `depth must be an integer in [0, 1000], got ${event.depth}`
      );
    }
    if (typeof event.temp !== 'number' || !Number.isFinite(event.temp)) {
      throw new ProfileError('INVALID_EVENT', 'temp must be a finite number');
    }
    let profile = this._liveProfile(event.profileId);
    if (!profile) {
      profile = new Profile(event.profileId);
      this.profiles.set(event.profileId, profile);
    }
    profile.upsert({ depth: event.depth, temp: event.temp, version: event.version, timeMs });
    return {
      type: 'UPSERT_OK',
      profileId: event.profileId,
      depth: event.depth,
      version: event.version,
    };
  }

  _retract(event) {
    const timeMs = this._common(event);
    if (!isValidDepth(event.depth)) {
      throw new ProfileError(
        'INVALID_DEPTH',
        `depth must be an integer in [0, 1000], got ${event.depth}`
      );
    }
    let profile = this._liveProfile(event.profileId);
    if (!profile) {
      throw new ProfileError(
        'UNKNOWN_RETRACT',
        `profile ${event.profileId} depth ${event.depth}: no observation to retract`
      );
    }
    profile.retract({ depth: event.depth, version: event.version, timeMs });
    return {
      type: 'RETRACT_OK',
      profileId: event.profileId,
      depth: event.depth,
      version: event.version,
    };
  }

  _watermark(event) {
    const timeMs = parseTimeMs(event && event.time);
    if (timeMs === null) {
      throw new ProfileError('INVALID_EVENT', `unparseable watermark time: ${event && event.time}`);
    }
    const certs = [];
    for (const profile of this.profiles.values()) {
      if (profile.closed || profile.lastObservationMs === null) continue;
      if (timeMs > profile.lastObservationMs + this.sessionGapMs) {
        profile.closed = true;
        certs.push(profile.certificate());
      }
    }
    certs.sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
    return certs;
  }
}

module.exports = { Engine, parseTimeMs, SESSION_GAP_MS };
