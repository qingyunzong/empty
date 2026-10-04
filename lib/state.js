'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { AuditError } = require('./errors');
const { loadRules } = require('./rules');

function hashRules(rules) {
  return crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) {
    return { version: 1, current: null, snapshots: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

function publicRules(rules) {
  return rules.map((r) => ({ id: r.id, pattern: r.pattern, action: r.action }));
}

// Apply a new rule version. The previous version (if any) is recorded as an
// explicit snapshot before switching. Rules are fully validated first, so a
// bad rule set never touches the state file.
function applyRules(statePath, rulesObj) {
  const rules = publicRules(loadRules(rulesObj));
  const state = loadState(statePath);
  if (state.current) {
    state.snapshots.push({ hash: state.current.hash, rules: state.current.rules });
  }
  const hash = hashRules(rules);
  state.current = { hash, rules };
  saveState(statePath, state);
  return { applied: true, hash, snapshots: state.snapshots.length };
}

// Record an explicit snapshot of the current version without changing it.
function snapshot(statePath) {
  const state = loadState(statePath);
  if (!state.current) {
    throw new AuditError('NO_SNAPSHOT', 'no current rule version to snapshot');
  }
  state.snapshots.push({ hash: state.current.hash, rules: state.current.rules });
  saveState(statePath, state);
  return { snapshot: true, hash: state.current.hash, snapshots: state.snapshots.length };
}

// Undo restores the most recent explicit snapshot only. Unknown conflicts
// are never treated as a non-match: with no snapshot there is nothing to
// fall back to, and that is reported as NO_SNAPSHOT.
function undo(statePath) {
  const state = loadState(statePath);
  if (state.snapshots.length === 0) {
    throw new AuditError('NO_SNAPSHOT', 'no explicit snapshot to undo to');
  }
  const restored = state.snapshots.pop();
  state.current = { hash: restored.hash, rules: restored.rules };
  saveState(statePath, state);
  return { undone: true, hash: restored.hash, snapshots: state.snapshots.length };
}

function status(statePath) {
  const state = loadState(statePath);
  return {
    current: state.current ? state.current.hash : null,
    snapshots: state.snapshots.length,
  };
}

module.exports = { applyRules, snapshot, undo, status, hashRules, loadState };
