'use strict';

const crypto = require('crypto');

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Deterministic JSON serialization (sorted object keys).
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function hashObj(v) {
  return sha256hex(canonical(v));
}

// Build an audit certificate for a scan. `hitEntries` is a flat, ordered list
// of {line, start, end, ruleId, kind}; `trajectories[i]` is the automaton
// state sequence for hitEntries[i].
function buildProof({ rulesHash, fileHash, lineCount, hitEntries, trajectories, stats }) {
  const trajectory = hitEntries.map((h, i) => ({
    i,
    line: h.line,
    start: h.start,
    end: h.end,
    ruleId: h.ruleId,
    kind: h.kind,
    states: hashObj(trajectories[i]),
  }));
  return {
    version: 1,
    algo: 'sha256',
    rulesHash,
    fileHash,
    lineCount,
    hitsHash: hashObj(hitEntries),
    trajectory,
    trajHash: hashObj(trajectory),
    stats,
  };
}

module.exports = { sha256hex, canonical, hashObj, buildProof };
