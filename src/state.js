'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { RcError } = require('./errors');

// Committed state lives in <statePath>. A journal dir <statePath>.journal/
// holds per-run files:
//   decisions-<runId>.json   phase 1: evaluated decisions
//   checkpoint-<runId>.json  phase 2: quota deltas to apply
//   committed-<runId>        phase 3: commit marker (written after state save)
// Commit protocol: decisions -> checkpoint -> apply+save state -> marker ->
// cleanup. Recovery is idempotent: a run whose runId is already in
// state.committedRunIds is never applied twice (no double quota deduction).

const FAULT_POINTS = ['before-decision', 'after-decision', 'after-checkpoint'];

class FaultInjected extends Error {
  constructor(point) {
    super(`fault injected at: ${point}`);
    this.code = 'FAULT_INJECTED';
    this.point = point;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function stateHash(state) {
  return createHash('sha256').update(stableStringify(state)).digest('hex');
}

function journalDir(statePath) {
  return `${statePath}.journal`;
}

function emptyState() {
  return { accounts: {}, runs: [], committedRunIds: [] };
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return emptyState();
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveStateAtomic(statePath, state) {
  const tmp = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function pendingRuns(statePath) {
  const dir = journalDir(statePath);
  if (!fs.existsSync(dir)) return { decisions: [], checkpoints: [] };
  const files = fs.readdirSync(dir);
  return {
    decisions: files.filter((f) => f.startsWith('decisions-')).map((f) => path.join(dir, f)),
    checkpoints: files.filter((f) => f.startsWith('checkpoint-')).map((f) => path.join(dir, f)),
  };
}

function ensureAccount(state, account, quota) {
  if (!state.accounts[account]) {
    state.accounts[account] = { quota, used: 0 };
  }
  return state.accounts[account];
}

// decisions: [{id, account, amount, decision}] — only ACCEPT entries deduct quota.
function computeDeltas(state, decisions, quota) {
  const deltas = {};
  for (const d of decisions) {
    if (d.decision !== 'ACCEPT') continue;
    const acct = ensureAccount(state, d.account, quota);
    if (acct.used + d.amount > acct.quota) {
      d.decision = 'REJECT';
      d.reason = 'QUOTA_EXCEEDED';
      continue;
    }
    acct.used += d.amount; // simulated on a working copy
    deltas[d.account] = (deltas[d.account] || 0) + d.amount;
  }
  return deltas;
}

function commitRun(statePath, runId) {
  const dir = journalDir(statePath);
  const checkpointFile = path.join(dir, `checkpoint-${runId}.json`);
  const markerFile = path.join(dir, `committed-${runId}`);
  const decisionsFile = path.join(dir, `decisions-${runId}.json`);
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  const state = loadState(statePath);
  if (!state.committedRunIds.includes(runId)) {
    for (const [account, delta] of Object.entries(checkpoint.deltas)) {
      const acct = ensureAccount(state, account, checkpoint.quota);
      acct.used += delta;
    }
    state.runs.push({ runId, deltas: checkpoint.deltas, txIds: checkpoint.txIds, undone: false });
    state.committedRunIds.push(runId);
  }
  saveStateAtomic(statePath, state);
  fs.writeFileSync(markerFile, runId);
  for (const f of [checkpointFile, decisionsFile]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  return state;
}

function applyRun({ statePath, decisions, quota = 50000, failAt = null, runId = null }) {
  if (failAt !== null && !FAULT_POINTS.includes(failAt)) {
    throw new RcError('RULE_PARSE', `unknown fault point: ${failAt}`);
  }
  const pending = pendingRuns(statePath);
  if (pending.decisions.length > 0 || pending.checkpoints.length > 0) {
    throw new RcError(
      'APPLY_CONFLICT',
      'incomplete apply detected; run `recover` before applying again'
    );
  }
  runId = runId || `run-${Date.now()}-${process.pid}`;
  const dir = journalDir(statePath);
  fs.mkdirSync(dir, { recursive: true });

  // Phase 1: decisions
  if (failAt === 'before-decision') throw new FaultInjected(failAt);
  const working = loadState(statePath);
  const deltas = computeDeltas(working, decisions, quota);
  fs.writeFileSync(
    path.join(dir, `decisions-${runId}.json`),
    JSON.stringify({ runId, decisions })
  );

  // Phase 2: checkpoint
  if (failAt === 'after-decision') throw new FaultInjected(failAt);
  const txIds = decisions.filter((d) => d.decision === 'ACCEPT').map((d) => d.id);
  fs.writeFileSync(
    path.join(dir, `checkpoint-${runId}.json`),
    JSON.stringify({ runId, deltas, txIds, quota })
  );

  // Phase 3: commit
  if (failAt === 'after-checkpoint') throw new FaultInjected(failAt);
  const state = commitRun(statePath, runId);
  return { runId, decisions, state };
}

function recover(statePath) {
  const pending = pendingRuns(statePath);
  const recovered = [];
  for (const checkpointFile of pending.checkpoints) {
    const runId = path.basename(checkpointFile, '.json').slice('checkpoint-'.length);
    const marker = path.join(journalDir(statePath), `committed-${runId}`);
    if (!fs.existsSync(marker)) {
      commitRun(statePath, runId); // idempotent: skips if runId already committed
      recovered.push(runId);
    }
  }
  // stale decision files (crashed before checkpoint) carry no side effects
  for (const decisionsFile of pendingRuns(statePath).decisions) {
    fs.unlinkSync(decisionsFile);
  }
  return { recovered, state: loadState(statePath) };
}

function undo(statePath) {
  const state = loadState(statePath);
  const last = [...state.runs].reverse().find((r) => !r.undone);
  if (!last) {
    throw new RcError('UNDO_EMPTY', 'undo stack is empty');
  }
  for (const [account, delta] of Object.entries(last.deltas)) {
    const acct = state.accounts[account];
    if (acct) acct.used -= delta;
  }
  last.undone = true;
  saveStateAtomic(statePath, state);
  return { undoneRun: last.runId, state };
}

module.exports = {
  FAULT_POINTS,
  FaultInjected,
  stableStringify,
  stateHash,
  loadState,
  saveStateAtomic,
  applyRun,
  recover,
  undo,
  emptyState,
};
