import { reconcile, isBalanced, signature, totalImpact } from './reconcile.js';

export const EXHAUSTIVE_LIMIT = 8;

function keyOf(side, entryId) {
  return (side === 'expected' ? 'E:' : 'A:') + entryId;
}

// Lexicographic comparison of two sorted key arrays.
export function compareKeyLists(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function buildUniverse(expected, actual) {
  const entries = [];
  const byKey = new Map();
  for (const e of expected) {
    const key = keyOf('expected', e.entryId);
    entries.push({ key, side: 'expected', entry: e });
    byKey.set(key, e);
  }
  for (const e of actual) {
    const key = keyOf('actual', e.entryId);
    entries.push({ key, side: 'actual', entry: e });
    byKey.set(key, e);
  }
  return { entries, byKey };
}

function splitKeys(keys, byKey) {
  const expected = [];
  const actual = [];
  for (const key of keys) {
    if (key.startsWith('E:')) expected.push(byKey.get(key));
    else actual.push(byKey.get(key));
  }
  return { expected, actual };
}

function signatureOfKeys(keys, byKey) {
  const { expected, actual } = splitKeys(keys, byKey);
  return signature(reconcile(expected, actual));
}

// Entries referenced by the diffs, plus the same-side originals of invalid
// reversals (removing such an original would change the reversal's reason,
// so it belongs to the suspect closure).
function suspectKeys(diffs, byKey) {
  const keys = new Set();
  for (const e of diffs.missing) keys.add(keyOf('expected', e.entryId));
  for (const e of diffs.extra) keys.add(keyOf('actual', e.entryId));
  for (const m of diffs.amountMismatch) {
    keys.add(keyOf('expected', m.expected.entryId));
    keys.add(keyOf('actual', m.actual.entryId));
  }
  for (const r of diffs.invalidReversal) {
    keys.add(keyOf(r.side, r.entry.entryId));
    const original = byKey.get(keyOf(r.side, r.entry.reversalOf));
    if (original) keys.add(keyOf(r.side, original.entryId));
  }
  return keys;
}

function exhaustiveMinimize(universe, targetSignature) {
  const { entries, byKey } = universe;
  const n = entries.length;
  let best = null;
  for (let mask = 1; mask < (1 << n); mask += 1) {
    const keys = [];
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) keys.push(entries[i].key);
    }
    if (best && (keys.length > best.length ||
        (keys.length === best.length && compareKeyLists(keys, best) >= 0))) {
      continue;
    }
    keys.sort();
    if (signatureOfKeys(keys, byKey) !== targetSignature) continue;
    if (!best || keys.length < best.length ||
        (keys.length === best.length && compareKeyLists(keys, best) < 0)) {
      best = keys;
    }
  }
  return best;
}

function greedyMinimize(universe, targetSignature, startKeys) {
  const { byKey } = universe;
  let current = [...startKeys].sort();
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...current]) {
      const trial = current.filter((k) => k !== key);
      if (trial.length > 0 && signatureOfKeys(trial, byKey) === targetSignature) {
        current = trial;
        changed = true;
      }
    }
  }
  return current;
}

export function minimize(expected, actual) {
  const diffs = reconcile(expected, actual);
  const impact = totalImpact(diffs);
  if (isBalanced(diffs)) {
    return {
      balanced: true,
      algorithm: 'none',
      diffs,
      totalImpact: 0,
      minimalExpected: [],
      minimalActual: [],
      minimalKeys: [],
    };
  }

  const universe = buildUniverse(expected, actual);
  const targetSignature = signature(diffs);
  const total = expected.length + actual.length;

  let algorithm;
  let minimalKeys;
  if (total <= EXHAUSTIVE_LIMIT) {
    algorithm = 'exhaustive-lexmin';
    minimalKeys = exhaustiveMinimize(universe, targetSignature);
  } else {
    algorithm = 'greedy-1minimal';
    minimalKeys = greedyMinimize(universe, targetSignature, suspectKeys(diffs, universe.byKey));
  }

  const { expected: minimalExpected, actual: minimalActual } = splitKeys(
    minimalKeys,
    universe.byKey,
  );
  const byId = (a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);
  minimalExpected.sort(byId);
  minimalActual.sort(byId);

  return {
    balanced: false,
    algorithm,
    diffs,
    totalImpact: impact,
    minimalExpected,
    minimalActual,
    minimalKeys: [...minimalKeys].sort(),
  };
}
