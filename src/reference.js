'use strict';

// Full-enumeration QC reference: every transaction recomputes all frame flags
// and all night summaries from scratch, then derives the change set by
// diffing the previous and next fully computed states. Used to validate the
// incremental engine.

const { computeDerived, normalizeConfig, normalizeState, canonical, cmpStr } = require('./qc');
const { applyOp } = require('./engine');

function diffDerived(prevState, nextState, prev, next) {
  const frameDiffs = [];
  const ids = new Set([...Object.keys(prev.flags), ...Object.keys(next.flags)]);
  for (const id of ids) {
    const from = prev.flags[id] ?? null;
    const to = next.flags[id] ?? null;
    if (from === to) continue;
    const frame = nextState.frames[id] || prevState.frames[id];
    frameDiffs.push({ node: `frame:${id}`, layer: 'frame', night: frame.night, frameId: id, from, to });
  }
  frameDiffs.sort((a, b) => cmpStr(a.night, b.night) || cmpStr(a.frameId, b.frameId));

  const summaryDiffs = [];
  const nights = new Set([...Object.keys(prev.summaries), ...Object.keys(next.summaries)]);
  for (const night of nights) {
    const from = prev.summaries[night] ?? null;
    const to = next.summaries[night] ?? null;
    if (canonical(from) === canonical(to)) continue;
    summaryDiffs.push({ node: `summary:${night}`, layer: 'summary', night, from, to });
  }
  summaryDiffs.sort((a, b) => cmpStr(a.night, b.night));

  return [...frameDiffs, ...summaryDiffs];
}

class Reference {
  constructor(config = {}, state = {}) {
    this.config = normalizeConfig(config);
    this.state = normalizeState(state);
    this.derived = computeDerived(this.state, this.config);
  }

  applyTransaction(op) {
    const prevState = structuredClone(this.state);
    const prevDerived = this.derived;
    const err = applyOp(this.state, op, new Set(), new Set(), [], { flags: {} });
    if (err) {
      this.state = prevState;
      return { ok: false, error: err };
    }
    const next = computeDerived(this.state, this.config);
    this.derived = next;
    return { ok: true, diffs: diffDerived(prevState, this.state, prevDerived, next) };
  }
}

module.exports = { Reference, diffDerived };
