'use strict';

const INVERSION_THRESHOLD_C = 0.5;

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class Profile {
  constructor(id) {
    this.id = id;
    this.points = new Map();
    this.depths = [];
    this.inversionPairs = new Set();
    this.missingBlocks = [];
    this.sessionStartMs = null;
    this.sessionEndMs = null;
  }

  get size() {
    return this.depths.length;
  }

  get(depth) {
    return this.points.get(depth);
  }

  isInversion(shallow, deep) {
    const a = this.points.get(shallow);
    const b = this.points.get(deep);
    if (!a || !b) return false;
    return b.temp - a.temp > INVERSION_THRESHOLD_C;
  }

  touchSession(eventTimeMs) {
    if (this.sessionStartMs === null || eventTimeMs < this.sessionStartMs) {
      this.sessionStartMs = eventTimeMs;
    }
    if (this.sessionEndMs === null || eventTimeMs > this.sessionEndMs) {
      this.sessionEndMs = eventTimeMs;
    }
  }

  upsert(depth, temp, version, eventTimeMs) {
    const existing = this.points.get(depth);
    this.points.set(depth, { temp, version });
    this.touchSession(eventTimeMs);
    if (existing) {
      this.refreshPairsAround(depth);
      return;
    }
    const idx = lowerBound(this.depths, depth);
    const prev = idx > 0 ? this.depths[idx - 1] : null;
    const next = idx < this.depths.length ? this.depths[idx] : null;
    this.depths.splice(idx, 0, depth);
    if (prev !== null && next !== null) this.inversionPairs.delete(prev);
    if (prev !== null && this.isInversion(prev, depth)) this.inversionPairs.add(prev);
    if (next !== null && this.isInversion(depth, next)) this.inversionPairs.add(depth);
    this.insertIntoMissingBlocks(depth, idx);
  }

  retract(depth, eventTimeMs) {
    if (!this.points.has(depth)) return false;
    this.points.delete(depth);
    this.touchSession(eventTimeMs);
    const idx = lowerBound(this.depths, depth);
    const prev = idx > 0 ? this.depths[idx - 1] : null;
    const next = idx < this.depths.length - 1 ? this.depths[idx + 1] : null;
    this.depths.splice(idx, 1);
    this.inversionPairs.delete(prev);
    this.inversionPairs.delete(depth);
    if (prev !== null && next !== null && this.isInversion(prev, next)) {
      this.inversionPairs.add(prev);
    }
    this.removeFromMissingBlocks(depth);
    return true;
  }

  refreshPairsAround(depth) {
    const idx = lowerBound(this.depths, depth);
    const prev = idx > 0 ? this.depths[idx - 1] : null;
    const next = idx < this.depths.length - 1 ? this.depths[idx + 1] : null;
    if (prev !== null) {
      if (this.isInversion(prev, depth)) this.inversionPairs.add(prev);
      else this.inversionPairs.delete(prev);
    }
    if (next !== null) {
      if (this.isInversion(depth, next)) this.inversionPairs.add(depth);
      else this.inversionPairs.delete(depth);
    }
  }

  insertIntoMissingBlocks(depth, idx) {
    if (this.depths.length === 1) {
      this.missingBlocks = [];
      return;
    }
    if (idx === 0) {
      const newMin = depth;
      const oldMin = this.depths[1];
      if (newMin + 1 <= oldMin - 1) {
        this.missingBlocks.unshift({ start: newMin + 1, end: oldMin - 1 });
      }
      return;
    }
    if (idx === this.depths.length - 1) {
      const oldMax = this.depths[idx - 1];
      const newMax = depth;
      if (oldMax + 1 <= newMax - 1) {
        this.missingBlocks.push({ start: oldMax + 1, end: newMax - 1 });
      }
      return;
    }
    for (let i = 0; i < this.missingBlocks.length; i += 1) {
      const block = this.missingBlocks[i];
      if (depth < block.start || depth > block.end) continue;
      const left = block.start <= depth - 1 ? { start: block.start, end: depth - 1 } : null;
      const right = depth + 1 <= block.end ? { start: depth + 1, end: block.end } : null;
      const replacement = [];
      if (left) replacement.push(left);
      if (right) replacement.push(right);
      this.missingBlocks.splice(i, 1, ...replacement);
      return;
    }
  }

  removeFromMissingBlocks(depth) {
    if (this.depths.length === 0) {
      this.missingBlocks = [];
      return;
    }
    const min = this.depths[0];
    const max = this.depths[this.depths.length - 1];
    if (depth < min) {
      this.missingBlocks = this.missingBlocks.filter((b) => b.end >= min);
      return;
    }
    if (depth > max) {
      this.missingBlocks = this.missingBlocks.filter((b) => b.start <= max);
      return;
    }
    let leftIdx = -1;
    let rightIdx = -1;
    for (let i = 0; i < this.missingBlocks.length; i += 1) {
      if (this.missingBlocks[i].end === depth - 1) leftIdx = i;
      if (this.missingBlocks[i].start === depth + 1) rightIdx = i;
    }
    if (leftIdx !== -1 && rightIdx !== -1) {
      this.missingBlocks[leftIdx].end = this.missingBlocks[rightIdx].end;
      this.missingBlocks.splice(rightIdx, 1);
    } else if (leftIdx !== -1) {
      this.missingBlocks[leftIdx].end = depth;
    } else if (rightIdx !== -1) {
      this.missingBlocks[rightIdx].start = depth;
    } else {
      const block = { start: depth, end: depth };
      let pos = 0;
      while (pos < this.missingBlocks.length && this.missingBlocks[pos].end < depth) pos += 1;
      this.missingBlocks.splice(pos, 0, block);
    }
  }

  inversionPairList() {
    const pairs = [];
    for (let i = 0; i + 1 < this.depths.length; i += 1) {
      if (this.inversionPairs.has(this.depths[i])) {
        pairs.push([this.depths[i], this.depths[i + 1]]);
      }
    }
    return pairs;
  }

  maxInversionLayer() {
    let best = null;
    let runStart = null;
    let runPairs = 0;
    const flush = (endDepth) => {
      if (runStart === null) return;
      const candidate = { from: runStart, to: endDepth, pairCount: runPairs };
      if (
        best === null ||
        candidate.pairCount > best.pairCount ||
        (candidate.pairCount === best.pairCount &&
          (candidate.to - candidate.from > best.to - best.from ||
            (candidate.to - candidate.from === best.to - best.from && candidate.from < best.from)))
      ) {
        best = candidate;
      }
      runStart = null;
      runPairs = 0;
    };
    for (let i = 0; i + 1 < this.depths.length; i += 1) {
      if (this.inversionPairs.has(this.depths[i])) {
        if (runStart === null) runStart = this.depths[i];
        runPairs += 1;
      } else {
        flush(this.depths[i]);
      }
    }
    if (runStart !== null) flush(this.depths[this.depths.length - 1]);
    return best;
  }

  missingStats() {
    const blocks = this.missingBlocks.map((b) => ({
      start: b.start,
      end: b.end,
      count: b.end - b.start + 1,
    }));
    const missingCount = blocks.reduce((acc, b) => acc + b.count, 0);
    return { blockCount: blocks.length, missingCount, blocks };
  }
}

module.exports = { Profile, INVERSION_THRESHOLD_C };
