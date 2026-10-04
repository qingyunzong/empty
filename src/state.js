'use strict';

// Rule-version state with explicit snapshots. `apply` installs a new rule
// set (validated first; nothing is written on failure). `undo` may only
// revert to an explicitly created snapshot; without one it fails with
// NO_SNAPSHOT and leaves the state file untouched.

const fs = require('fs');
const crypto = require('crypto');
const { compileRules } = require('./ledger');

class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotError';
    this.code = 'NO_SNAPSHOT';
  }
}

function canonicalRules(rules) {
  return rules.map((r) => ({ id: r.id, pattern: r.pattern, decision: r.decision }));
}

function hashRules(rules) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalRules(rules))).digest('hex');
}

function loadState(path) {
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function saveState(path, state) {
  fs.writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

function initialState() {
  return { rules: [], hash: hashRules([]), snapshots: [], history: [] };
}

function applyRules(path, ruleDefs) {
  compileRules(ruleDefs); // validates every rule; throws BAD_REGEX before any write
  const state = loadState(path) || initialState();
  const next = hashRules(ruleDefs);
  state.history.push({ op: 'apply', from: state.hash, to: next });
  state.rules = canonicalRules(ruleDefs);
  state.hash = next;
  saveState(path, state);
  return state;
}

function snapshot(path) {
  const state = loadState(path) || initialState();
  state.snapshots.push({ hash: state.hash, rules: state.rules });
  state.history.push({ op: 'snapshot', hash: state.hash });
  saveState(path, state);
  return state;
}

function undo(path) {
  const state = loadState(path);
  if (!state || state.snapshots.length === 0) {
    throw new SnapshotError('no explicit snapshot to undo to');
  }
  const snap = state.snapshots.pop();
  state.history.push({ op: 'undo', from: state.hash, to: snap.hash });
  state.rules = snap.rules;
  state.hash = snap.hash;
  saveState(path, state);
  return state;
}

module.exports = { applyRules, snapshot, undo, loadState, hashRules, SnapshotError };
