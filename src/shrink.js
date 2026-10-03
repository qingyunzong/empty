import { InvalidCommand, canonicalCommand, runBatch, INVARIANTS } from './ledger.js';

function* combinations(n, k) {
  if (k < 0 || k > n) return;
  if (k === 0) {
    yield [];
    return;
  }
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

export function compareCanonicalSequences(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function tryRun(commands, limits) {
  try {
    return runBatch(commands, limits);
  } catch (err) {
    if (err instanceof InvalidCommand) return null;
    throw err;
  }
}

export function findMinimalCounterexample(commands, limits) {
  const n = commands.length;
  for (let k = 0; k <= n; k += 1) {
    let best = null;
    for (const idxs of combinations(n, k)) {
      const sub = idxs.map((i) => commands[i]);
      const result = tryRun(sub, limits);
      if (result === null || result.ok) continue;
      const key = sub.map(canonicalCommand);
      if (best === null || compareCanonicalSequences(key, best.key) < 0) {
        best = { idxs, sub, key, result };
      }
    }
    if (best !== null) return best;
  }
  return null;
}

export function shrinkPlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new InvalidCommand('plan must be an object with limits and commands');
  }
  const commands = plan.commands;
  if (!Array.isArray(commands)) {
    throw new InvalidCommand('plan.commands must be an array');
  }
  const limits = plan.limits ?? {};

  const full = runBatch(commands, limits);
  if (full.ok) {
    return {
      status: 'SAFE',
      certificate: {
        invariants: [...INVARIANTS],
        commandsChecked: commands.length,
        replayHash: full.replayHash,
      },
      finalState: full.finalState,
      replayHash: full.replayHash,
    };
  }

  const best = findMinimalCounterexample(commands, limits);
  const removedIndices = new Set(best.idxs);
  const removed = commands
    .map((cmd, index) => ({ index, command: canonicalCommand(cmd) }))
    .filter((item) => !removedIndices.has(item.index));

  return {
    status: 'UNSAFE',
    counterexample: best.sub.map((cmd) => ({ ...cmd })),
    counterexampleCanonical: best.key,
    removed,
    violations: best.result.violations,
    finalState: best.result.finalState,
    replayHash: best.result.replayHash,
  };
}
