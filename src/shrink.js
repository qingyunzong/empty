'use strict';

const { runCommands, canonical, InvalidCommandError } = require('./ledger.js');

// Yield index combinations of size k from n, in lexicographic index order.
function* combinations(n, k) {
  if (k < 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
}

function compareCommands(a, b) {
  const sa = canonical(a);
  const sb = canonical(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareSequences(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const c = compareCommands(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

// A subsequence is a usable counterexample only if it is itself a valid
// command sequence (invalid ones are rejected, not unsafe) and it fails.
function failingRun(commands, limits) {
  try {
    const result = runCommands(commands, limits);
    return result.ok ? null : result;
  } catch (err) {
    if (err instanceof InvalidCommandError) return null;
    throw err;
  }
}

// Find the shortest failing subsequence; ties broken by lexicographically
// smallest canonical serialization. Exhaustive over subset sizes, so the
// result is provably minimal.
function minimize(commands, limits) {
  let best = null;
  let subsetsTested = 0;
  for (let k = 1; k <= commands.length; k += 1) {
    for (const idx of combinations(commands.length, k)) {
      subsetsTested += 1;
      const sub = idx.map((i) => commands[i]);
      const run = failingRun(sub, limits);
      if (run && (best === null || compareSequences(sub, best.commands) < 0)) {
        best = { commands: sub, indices: idx, run };
      }
    }
    if (best) return { ...best, subsetsTested };
  }
  return null;
}

function audit(plan) {
  const limits = (plan && plan.limits) || {};
  const commands = plan && plan.commands;
  const full = runCommands(commands, limits); // throws InvalidCommandError

  if (full.ok) {
    // Certificate: re-verify determinism and probe every single-command
    // deletion to confirm none of them changes the safety conclusion.
    const replay = runCommands(commands, limits);
    const deletions = commands.map((cmd, i) => {
      const rest = commands.filter((_, j) => j !== i);
      let safe;
      try {
        safe = runCommands(rest, limits).ok;
      } catch (err) {
        if (err instanceof InvalidCommandError) safe = null; // deletion not replayable
        else throw err;
      }
      return { removedIndex: i, removed: cmd, safe };
    });
    return {
      status: 'SAFE',
      certificate: {
        commandsChecked: commands.length,
        finalState: full.finalState,
        replayHash: full.replayHash,
        replayDeterministic: replay.replayHash === full.replayHash,
        ledger: full.ledger,
        singleDeletionChecks: {
          tested: deletions.length,
          allSafe: deletions.every((d) => d.safe !== false),
          deletions,
        },
      },
    };
  }

  const minimal = minimize(commands, limits);
  const removedSet = new Set(minimal.indices);
  const removed = commands
    .map((cmd, i) => ({ index: i, command: cmd }))
    .filter((entry) => !removedSet.has(entry.index));
  return {
    status: 'UNSAFE',
    counterexample: {
      length: minimal.commands.length,
      commands: minimal.commands,
      removedIndices: removed.map((r) => r.index),
      removed: removed.map((r) => r.command),
      violations: minimal.run.violations,
      finalState: minimal.run.finalState,
      replayHash: minimal.run.replayHash,
      ledger: minimal.run.ledger,
    },
    minimality: {
      method: 'exhaustive-subset-enumeration',
      subsetsTested: minimal.subsetsTested,
      shortestFailingLength: minimal.commands.length,
      lexicographicallySmallestAmongShortest: true,
    },
  };
}

module.exports = { audit, minimize, combinations, compareSequences };
