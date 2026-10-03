'use strict';

// Backtracking solver: finds the lexicographically smallest serial schedule
// (by opId sequence) consistent with interval order, depends edges and the
// account state machine. Also extracts the minimum-cardinality UNSAT
// conflict subset (ties broken lexicographically).

const { createState, cloneState, applyCommand } = require('./model');

function compareOpIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedCommands(commands) {
  return [...commands].sort((x, y) => compareOpIds(x.opId, y.opId));
}

// Build predecessor sets: interval order (a.end <= b.start => a before b)
// plus depends edges restricted to commands present in the list.
function buildPredecessors(commands) {
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const preds = new Map(commands.map((c) => [c.opId, new Set()]));
  for (const cmd of commands) {
    for (const dep of cmd.depends) {
      if (byId.has(dep)) preds.get(cmd.opId).add(dep);
    }
  }
  for (const a of commands) {
    for (const b of commands) {
      if (a !== b && a.end <= b.start) preds.get(b.opId).add(a.opId);
    }
  }
  return preds;
}

// Lexicographically smallest valid schedule as an array of opIds, or null.
// DFS explores ready candidates in ascending opId order, so the first
// complete schedule found is the lexicographic minimum.
function findSchedule(commands, balances) {
  if (commands.length === 0) return [];
  const sorted = sortedCommands(commands);
  const preds = buildPredecessors(sorted);
  const states = [createState(balances)];
  const order = [];
  const placed = new Set();

  function dfs() {
    if (order.length === sorted.length) return true;
    const state = states[order.length];
    for (const cmd of sorted) {
      if (placed.has(cmd.opId)) continue;
      let ready = true;
      for (const pred of preds.get(cmd.opId)) {
        if (!placed.has(pred)) { ready = false; break; }
      }
      if (!ready) continue;
      const next = cloneState(state);
      if (applyCommand(next, cmd) !== null) continue;
      placed.add(cmd.opId);
      order.push(cmd.opId);
      states[order.length] = next;
      if (dfs()) return true;
      placed.delete(cmd.opId);
      order.pop();
      states.length = order.length + 1;
    }
    return false;
  }

  return dfs() ? [...order] : null;
}

function* combinations(ids, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  const remaining = k - prefix.length;
  for (let i = start; i <= ids.length - remaining; i += 1) {
    prefix.push(ids[i]);
    yield* combinations(ids, k, i + 1, prefix);
    prefix.pop();
  }
}

// Above this size full subset enumeration is impractical; a deterministic
// greedy inclusion-minimal subset is produced instead.
const EXACT_CONFLICT_LIMIT = 16;

// Minimum-cardinality UNSAT subset (sorted opIds), ties broken
// lexicographically. Assumes the full command set is UNSAT.
function findMinimalConflict(commands, balances) {
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const ids = [...byId.keys()].sort(compareOpIds);
  if (ids.length > EXACT_CONFLICT_LIMIT) return greedyConflict(commands, balances);
  for (let k = 1; k <= ids.length; k += 1) {
    for (const combo of combinations(ids, k)) {
      const subset = combo.map((id) => byId.get(id));
      if (findSchedule(subset, balances) === null) return [...combo];
    }
  }
  return null; // reachable only if the full set is SAT
}

// Deterministic inclusion-minimal conflict for large inputs: repeatedly
// remove the lexicographically largest command whose removal keeps UNSAT.
function greedyConflict(commands, balances) {
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const remaining = new Set(byId.keys());
  let changed = true;
  while (changed) {
    changed = false;
    const ids = [...remaining].sort(compareOpIds).reverse();
    for (const id of ids) {
      remaining.delete(id);
      const subset = [...remaining].map((x) => byId.get(x));
      if (findSchedule(subset, balances) === null) {
        changed = true;
        break;
      }
      remaining.add(id);
    }
  }
  return [...remaining].sort(compareOpIds);
}

module.exports = {
  compareOpIds,
  buildPredecessors,
  findSchedule,
  findMinimalConflict,
  EXACT_CONFLICT_LIMIT,
};
