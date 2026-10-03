'use strict';

const crypto = require('node:crypto');
const {
  cmpStr,
  canonical,
  normalizeConfig,
  normalizeState,
  computeDerived,
  frameFlag,
  summarize,
} = require('./qc');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const VALID_WEATHER_STATUS = new Set(['clear', 'degraded', 'blocked']);

// Applies `op` to `state` in place and records invalidated dependency nodes:
// frames to recompute (invFrames) and nights whose summary may change
// (invNights). Removed frames are reported through `removedFrames`.
// Returns null on success, or an error code string.
function applyOp(state, op, invFrames, invNights, removedFrames, derived) {
  switch (op && op.type) {
    case 'addFrame': {
      const f = op.frame;
      if (
        !f ||
        typeof f.id !== 'string' ||
        typeof f.night !== 'string' ||
        typeof f.instrument !== 'string' ||
        typeof f.signal !== 'number' ||
        state.frames[f.id]
      ) {
        return 'E_INVALID';
      }
      state.frames[f.id] = { id: f.id, night: f.night, instrument: f.instrument, signal: f.signal };
      invFrames.add(f.id);
      invNights.add(f.night);
      return null;
    }
    case 'removeFrame': {
      const f = state.frames[op.frameId];
      if (!f) return 'E_INVALID';
      removedFrames.push({ frame: { ...f }, flag: derived.flags[f.id] ?? null });
      delete state.frames[f.id];
      invNights.add(f.night);
      return null;
    }
    case 'regroup': {
      const f = state.frames[op.frameId];
      if (!f) return 'E_INVALID';
      if (op.night !== undefined && typeof op.night !== 'string') return 'E_INVALID';
      if (op.instrument !== undefined && typeof op.instrument !== 'string') return 'E_INVALID';
      const night = typeof op.night === 'string' ? op.night : f.night;
      const instrument = typeof op.instrument === 'string' ? op.instrument : f.instrument;
      invNights.add(f.night);
      invNights.add(night);
      f.night = night;
      f.instrument = instrument;
      invFrames.add(f.id);
      return null;
    }
    case 'setCalibration': {
      if (typeof op.instrument !== 'string') return 'E_INVALID';
      if (op.dark !== undefined && op.dark !== null && typeof op.dark !== 'number') return 'E_INVALID';
      if (op.flat !== undefined && op.flat !== null && typeof op.flat !== 'number') return 'E_INVALID';
      const cal = state.calibrations[op.instrument] || {};
      if (op.dark !== undefined) cal.dark = op.dark;
      if (op.flat !== undefined) cal.flat = op.flat;
      state.calibrations[op.instrument] = cal;
      for (const f of Object.values(state.frames)) {
        if (f.instrument === op.instrument) {
          invFrames.add(f.id);
          invNights.add(f.night);
        }
      }
      return null;
    }
    case 'removeCalibration': {
      if (typeof op.instrument !== 'string' || !state.calibrations[op.instrument]) {
        return 'E_INVALID';
      }
      delete state.calibrations[op.instrument];
      for (const f of Object.values(state.frames)) {
        if (f.instrument === op.instrument) {
          invFrames.add(f.id);
          invNights.add(f.night);
        }
      }
      return null;
    }
    case 'setWeather': {
      if (typeof op.night !== 'string') return 'E_INVALID';
      const prev = state.weather[op.night] || {};
      const status = op.status === undefined ? prev.status ?? 'clear' : op.status;
      if (!VALID_WEATHER_STATUS.has(status)) return 'E_INVALID';
      const attenuation = op.attenuation === undefined ? prev.attenuation ?? 1 : op.attenuation;
      if (typeof attenuation !== 'number') return 'E_INVALID';
      state.weather[op.night] = { status, attenuation };
      let touched = false;
      for (const f of Object.values(state.frames)) {
        if (f.night === op.night) {
          invFrames.add(f.id);
          touched = true;
        }
      }
      if (touched) invNights.add(op.night);
      return null;
    }
    default:
      return 'E_INVALID';
  }
}

class Engine {
  constructor(config = {}, state = {}) {
    this.config = normalizeConfig(config);
    this.state = normalizeState(state);
    this.derived = computeDerived(this.state, this.config);
    this.txCount = 0;
  }

  stateHash() {
    return sha256(canonical(this.derived));
  }

  getState() {
    return structuredClone(this.state);
  }

  getFlags() {
    return structuredClone(this.derived.flags);
  }

  getSummaries() {
    return structuredClone(this.derived.summaries);
  }

  getDerived() {
    return structuredClone(this.derived);
  }

  // Executes one transaction. The op is applied to a working copy; dependent
  // frames and night summaries are recomputed along the dependency graph.
  // `budget` caps the number of recomputed derived nodes (frames + summaries);
  // exceeding it returns E_BUDGET and rolls back (no state is committed).
  applyTransaction(tx = {}) {
    const txIndex = this.txCount;
    const op = tx.op || {};
    const budget = typeof tx.budget === 'number' ? tx.budget : Infinity;

    const state = structuredClone(this.state);
    const derived = structuredClone(this.derived);
    const invFrames = new Set();
    const invNights = new Set();
    const removedFrames = [];

    const err = applyOp(state, op, invFrames, invNights, removedFrames, derived);
    if (err) return { ok: false, tx: txIndex, op, error: err };

    let work = 0;
    const frameDiffs = [];

    const ids = [...invFrames].sort((a, b) => {
      const fa = state.frames[a];
      const fb = state.frames[b];
      return cmpStr(fa.night, fb.night) || cmpStr(a, b);
    });
    for (const id of ids) {
      work += 1;
      const frame = state.frames[id];
      const to = frameFlag(
        frame,
        state.calibrations[frame.instrument],
        state.weather[frame.night],
        this.config.threshold
      );
      const from = derived.flags[id] ?? null;
      if (from !== to) {
        frameDiffs.push({ node: `frame:${id}`, layer: 'frame', night: frame.night, frameId: id, from, to });
        derived.flags[id] = to;
        invNights.add(frame.night);
      }
    }
    for (const { frame, flag } of removedFrames) {
      delete derived.flags[frame.id];
      frameDiffs.push({
        node: `frame:${frame.id}`,
        layer: 'frame',
        night: frame.night,
        frameId: frame.id,
        from: flag,
        to: null,
      });
    }
    frameDiffs.sort((a, b) => cmpStr(a.night, b.night) || cmpStr(a.frameId, b.frameId));

    const summaryDiffs = [];
    const nights = [...invNights].sort(cmpStr);
    for (const night of nights) {
      work += 1;
      const flags = Object.values(state.frames)
        .filter((f) => f.night === night)
        .sort((a, b) => cmpStr(a.id, b.id))
        .map((f) => derived.flags[f.id]);
      const from = derived.summaries[night] ?? null;
      if (flags.length === 0) {
        if (from) {
          delete derived.summaries[night];
          summaryDiffs.push({ node: `summary:${night}`, layer: 'summary', night, from, to: null });
        }
      } else {
        const to = summarize(night, flags);
        if (!from || canonical(from) !== canonical(to)) {
          derived.summaries[night] = to;
          summaryDiffs.push({ node: `summary:${night}`, layer: 'summary', night, from, to });
        }
      }
    }

    if (work > budget) {
      return { ok: false, tx: txIndex, op, error: 'E_BUDGET', required: work, budget };
    }

    this.state = state;
    this.derived = derived;
    this.txCount += 1;

    const diffs = [...frameDiffs, ...summaryDiffs];
    const queue = diffs.map((d) => {
      const entry = { node: d.node, layer: d.layer, night: d.night };
      if (d.layer === 'frame') entry.frameId = d.frameId;
      return entry;
    });
    const stateHash = this.stateHash();
    const certificate =
      'sha256:' +
      sha256(canonical({ v: 1, tx: txIndex, op, queue: queue.map((q) => q.node), diffs, state: stateHash }));

    return { ok: true, tx: txIndex, op, diffs, queue, stateHash, certificate };
  }
}

function verifyCertificate(entry, expectedStateHash) {
  if (!entry || typeof entry.certificate !== 'string') return false;
  const recomputed =
    'sha256:' +
    sha256(
      canonical({
        v: 1,
        tx: entry.tx,
        op: entry.op,
        queue: (entry.queue || []).map((q) => q.node),
        diffs: entry.diffs || [],
        state: expectedStateHash,
      })
    );
  return recomputed === entry.certificate;
}

module.exports = { Engine, applyOp, verifyCertificate, sha256 };
