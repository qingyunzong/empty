import fs from 'node:fs';
import path from 'node:path';
import { ReplanError } from './errors.js';

export function newState({ dag, budget, plan, excluded = [], dagPath = null, budgetPath = null }) {
  return {
    version: 1,
    dagPath,
    budgetPath,
    dag,
    budget,
    plan: [...plan],
    excluded: [...excluded],
    completed: [],
    failed: [],
    skipped: [],
    checkpointed: [],
    attempts: {},
    log: [],
  };
}

export function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

export function loadState(statePath) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    throw new ReplanError('E_USAGE', `state: cannot read ${statePath}: ${e.message}`);
  }
  if (doc === null || typeof doc !== 'object' || doc.version !== 1) {
    throw new ReplanError('E_USAGE', `state: ${statePath} is not a version-1 state file`);
  }
  return doc;
}

export function ckptDir(statePath) {
  return `${statePath}.ckpt`;
}

export function ckptPath(statePath, taskId) {
  return path.join(ckptDir(statePath), `${encodeURIComponent(taskId)}.json`);
}

// Checkpoint records are deterministic (no timestamps, no randomness).
export function writeCheckpoint(statePath, state, taskId) {
  fs.mkdirSync(ckptDir(statePath), { recursive: true });
  const rec = { task: taskId, attempt: state.attempts[taskId] ?? 0 };
  fs.writeFileSync(ckptPath(statePath, taskId), JSON.stringify(rec) + '\n');
  if (!state.checkpointed.includes(taskId)) state.checkpointed.push(taskId);
}

// Every checkpointed-but-not-completed task must have an intact record,
// otherwise recovery is impossible: E_LOST_CKPT.
export function verifyCheckpoints(statePath, state) {
  for (const id of state.checkpointed) {
    if (state.completed.includes(id)) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(ckptPath(statePath, id), 'utf8'));
    } catch {
      throw new ReplanError('E_LOST_CKPT', `checkpoint lost for task "${id}" (expected at ${ckptPath(statePath, id)})`);
    }
    if (rec === null || typeof rec !== 'object' || rec.task !== id) {
      throw new ReplanError('E_LOST_CKPT', `checkpoint corrupt for task "${id}"`);
    }
  }
}
