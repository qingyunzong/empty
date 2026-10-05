'use strict';

const INVERSION_THRESHOLD_C = 0.5;
const MIN_DEPTH_M = 0;
const MAX_DEPTH_M = 1000;

function lowerBound(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

function isValidDepth(depth) {
  return (
    typeof depth === 'number' &&
    Number.isInteger(depth) &&
    depth >= MIN_DEPTH_M &&
    depth <= MAX_DEPTH_M
  );
}

class Profile {
  constructor(id) {
    this.id = id;
    this.points = new Map(); // depth -> { temp, version, timeMs }
    this.versions = new Map(); // depth -> highest version ever seen (kept after retract)
    this.depths = []; // sorted ascending
    this.inversionTops = new Set(); // depths d where pair (d, next(d)) is an inversion
    this.lastObservationMs = null;
    this.closed = false;
  }

  _touch(timeMs) {
    if (this.lastObservationMs === null || timeMs > this.lastObservationMs) {
      this.lastObservationMs = timeMs;
    }
  }

  _isInversion(topDepth, bottomDepth) {
    const top = this.points.get(topDepth);
    const bottom = this.points.get(bottomDepth);
    return bottom.temp - top.temp > INVERSION_THRESHOLD_C;
  }

  _refreshPair(topDepth) {
    const idx = lowerBound(this.depths, topDepth);
    if (idx >= this.depths.length || this.depths[idx] !== topDepth) return;
    const next = this.depths[idx + 1];
    if (next === undefined) {
      this.inversionTops.delete(topDepth);
      return;
    }
    if (this._isInversion(topDepth, next)) this.inversionTops.add(topDepth);
    else this.inversionTops.delete(topDepth);
  }

  _refreshPairsAround(depth) {
    const idx = lowerBound(this.depths, depth);
    if (idx > 0) this._refreshPair(this.depths[idx - 1]);
    if (idx < this.depths.length && this.depths[idx] === depth) {
      this._refreshPair(depth);
    }
  }

  upsert({ depth, temp, version, timeMs }) {
    const known = this.versions.get(depth);
    if (known !== undefined && version <= known) {
      throw new ProfileError(
        'STALE_VERSION',
        `profile ${this.id} depth ${depth}: version ${version} <= current ${known}`
      );
    }
    this.versions.set(depth, version);
    if (!this.points.has(depth)) {
      this.depths.splice(lowerBound(this.depths, depth), 0, depth);
    }
    this.points.set(depth, { temp, version, timeMs });
    this._touch(timeMs);
    this._refreshPairsAround(depth);
  }

  retract({ depth, version, timeMs }) {
    if (!this.points.has(depth)) {
      throw new ProfileError(
        'UNKNOWN_RETRACT',
        `profile ${this.id} depth ${depth}: no observation to retract`
      );
    }
    const known = this.versions.get(depth);
    if (version <= known) {
      throw new ProfileError(
        'STALE_VERSION',
        `profile ${this.id} depth ${depth}: version ${version} <= current ${known}`
      );
    }
    this.versions.set(depth, version);
    const idx = lowerBound(this.depths, depth);
    this.depths.splice(idx, 1);
    this.points.delete(depth);
    this.inversionTops.delete(depth);
    this._touch(timeMs);
    // The two neighbours of the removed point are now adjacent: recompute only that pair.
    if (idx > 0) this._refreshPair(this.depths[idx - 1]);
  }

  certificate() {
    const depths = [...this.depths];

    const inversions = [];
    for (let i = 0; i < depths.length - 1; i++) {
      if (this.inversionTops.has(depths[i])) {
        inversions.push([depths[i], depths[i + 1]]);
      }
    }

    let maxInversion = null;
    let i = 0;
    while (i < depths.length - 1) {
      if (!this.inversionTops.has(depths[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < depths.length - 1 && this.inversionTops.has(depths[j + 1])) {
        j++;
      }
      const top = depths[i];
      const bottom = depths[j + 1];
      if (maxInversion === null || bottom - top > maxInversion.span) {
        maxInversion = { top, bottom, span: bottom - top };
      }
      i = j + 1;
    }

    const blocks = [];
    for (let k = 0; k < depths.length - 1; k++) {
      const lo = depths[k] + 1;
      const hi = depths[k + 1] - 1;
      if (lo <= hi) blocks.push([lo, hi]);
    }
    const missingCount = blocks.reduce((sum, [lo, hi]) => sum + (hi - lo + 1), 0);

    return {
      type: 'CERTIFICATE',
      profileId: this.id,
      depths,
      inversions,
      maxInversion,
      missing: { blocks, blockCount: blocks.length, missingCount },
    };
  }
}

module.exports = {
  Profile,
  ProfileError,
  isValidDepth,
  INVERSION_THRESHOLD_C,
  MIN_DEPTH_M,
  MAX_DEPTH_M,
};
