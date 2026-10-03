import { createHash } from 'node:crypto';

export class ReconError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ReconError';
    this.code = 'INVALID_RECON';
  }
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

const ENTRY_TYPES = new Set(['normal', 'reversal']);

function validateEntry(raw, side, seenIds) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReconError(`${side}: every entry must be an object`);
  }
  const { entryId, account, amount, type, reversalOf = null } = raw;
  if (typeof entryId !== 'string' || entryId.length === 0) {
    throw new ReconError(`${side}: entryId must be a non-empty string`);
  }
  if (seenIds.has(entryId)) {
    throw new ReconError(`${side}: duplicate entryId "${entryId}"`);
  }
  seenIds.add(entryId);
  if (typeof account !== 'string' || account.length === 0) {
    throw new ReconError(`${side}: entry "${entryId}" has invalid account`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ReconError(`${side}: entry "${entryId}" has invalid amount`);
  }
  if (amount < 0) {
    throw new ReconError(`${side}: entry "${entryId}" has negative amount`);
  }
  if (!ENTRY_TYPES.has(type)) {
    throw new ReconError(`${side}: entry "${entryId}" has invalid type "${String(type)}"`);
  }
  if (type === 'reversal') {
    if (typeof reversalOf !== 'string' || reversalOf.length === 0) {
      throw new ReconError(`${side}: reversal "${entryId}" requires reversalOf`);
    }
    if (reversalOf === entryId) {
      throw new ReconError(`${side}: reversal "${entryId}" references itself (invalid reversal chain)`);
    }
  } else if (reversalOf !== null) {
    throw new ReconError(`${side}: normal entry "${entryId}" must not carry reversalOf`);
  }
  const entry = { entryId, account, amount, type };
  if (type === 'reversal') entry.reversalOf = reversalOf;
  return entry;
}

function validateSide(raw, side) {
  if (!Array.isArray(raw)) throw new ReconError(`${side}: must be an array of entries`);
  const seenIds = new Set();
  const entries = raw.map((item) => validateEntry(item, side, seenIds));
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  for (const entry of entries) {
    if (entry.type !== 'reversal') continue;
    const target = byId.get(entry.reversalOf);
    if (target && target.type === 'reversal') {
      throw new ReconError(
        `${side}: reversal "${entry.entryId}" targets reversal "${target.entryId}" (invalid reversal chain)`,
      );
    }
  }
  return entries;
}

export function validateRecon(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ReconError('recon document must be an object with "expected" and "actual" arrays');
  }
  return {
    expected: validateSide(input.expected, 'expected'),
    actual: validateSide(input.actual, 'actual'),
  };
}

const KEY_SEP = '\u0001';

function matchKey(entry) {
  return [entry.entryId, entry.account, entry.amount].join(KEY_SEP);
}

function idAccountKey(entry) {
  return [entry.entryId, entry.account].join(KEY_SEP);
}

function applyReversals(entries, side, differences) {
  const normalsById = new Map();
  for (const entry of entries) {
    if (entry.type === 'normal') normalsById.set(entry.entryId, entry);
  }
  const cancelled = new Set();
  const excluded = new Set();
  for (const entry of entries) {
    if (entry.type !== 'reversal') continue;
    const origin = normalsById.get(entry.reversalOf);
    if (!origin || cancelled.has(origin)) {
      excluded.add(entry);
      differences.push({
        kind: 'invalid-reversal',
        reason: origin ? 'origin-already-reversed' : 'origin-missing',
        side,
        entryId: entry.entryId,
        reversalOf: entry.reversalOf,
        account: entry.account,
        amount: entry.amount,
      });
      continue;
    }
    if (origin.amount !== entry.amount) {
      excluded.add(entry);
      differences.push({
        kind: 'invalid-reversal',
        reason: 'amount-not-opposite',
        side,
        entryId: entry.entryId,
        reversalOf: entry.reversalOf,
        account: entry.account,
        amount: entry.amount,
        originAmount: origin.amount,
      });
      continue;
    }
    cancelled.add(origin);
    cancelled.add(entry);
  }
  return entries.filter((entry) => !cancelled.has(entry) && !excluded.has(entry));
}

export function reconcile(expected, actual) {
  const differences = [];
  const openExpected = applyReversals(expected, 'expected', differences);
  const openActual = applyReversals(actual, 'actual', differences);

  const actualByKey = new Map(openActual.map((entry) => [matchKey(entry), entry]));
  const missing = [];
  for (const entry of openExpected) {
    const key = matchKey(entry);
    if (actualByKey.has(key)) actualByKey.delete(key);
    else missing.push(entry);
  }
  const extra = [...actualByKey.values()];

  const totals = {
    missingCount: 0,
    extraCount: 0,
    mismatchCount: 0,
    invalidReversalCount: 0,
    missingAmount: 0,
    extraAmount: 0,
    mismatchDelta: 0,
    netImpact: 0,
  };

  const extraByIdAccount = new Map(extra.map((entry) => [idAccountKey(entry), entry]));
  for (const entry of missing) {
    const counterpart = extraByIdAccount.get(idAccountKey(entry));
    if (counterpart) {
      extraByIdAccount.delete(idAccountKey(entry));
      differences.push({
        kind: 'amount-mismatch',
        entryId: entry.entryId,
        account: entry.account,
        expectedAmount: entry.amount,
        actualAmount: counterpart.amount,
      });
      totals.mismatchCount += 1;
      totals.mismatchDelta += counterpart.amount - entry.amount;
      totals.netImpact += counterpart.amount - entry.amount;
    } else {
      differences.push({
        kind: 'missing',
        side: 'expected',
        entryId: entry.entryId,
        account: entry.account,
        amount: entry.amount,
      });
      totals.missingCount += 1;
      totals.missingAmount += entry.amount;
      totals.netImpact -= entry.amount;
    }
  }
  for (const entry of extraByIdAccount.values()) {
    differences.push({
      kind: 'extra',
      side: 'actual',
      entryId: entry.entryId,
      account: entry.account,
      amount: entry.amount,
    });
    totals.extraCount += 1;
    totals.extraAmount += entry.amount;
    totals.netImpact += entry.amount;
  }
  for (const difference of differences) {
    if (difference.kind !== 'invalid-reversal') continue;
    totals.invalidReversalCount += 1;
    totals.netImpact += difference.side === 'actual' ? -difference.amount : difference.amount;
  }

  differences.sort((left, right) => {
    const a = canonicalStringify(left);
    const b = canonicalStringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { balanced: differences.length === 0, differences, totals };
}

function canonicalItems(expected, actual) {
  const items = [
    ...expected.map((entry, index) => ({ side: 'expected', index, entry })),
    ...actual.map((entry, index) => ({ side: 'actual', index, entry })),
  ];
  items.sort((left, right) => {
    if (left.side !== right.side) return left.side < right.side ? -1 : 1;
    if (left.entry.entryId !== right.entry.entryId) return left.entry.entryId < right.entry.entryId ? -1 : 1;
    return left.index - right.index;
  });
  return items;
}

function* combinations(count, size) {
  if (size > count) return;
  const indices = Array.from({ length: size }, (_, i) => i);
  while (true) {
    yield indices.slice();
    let pivot = size - 1;
    while (pivot >= 0 && indices[pivot] === count - size + pivot) pivot -= 1;
    if (pivot < 0) return;
    indices[pivot] += 1;
    for (let i = pivot + 1; i < size; i += 1) indices[i] = indices[i - 1] + 1;
  }
}

export const EXHAUSTIVE_LIMIT = 8;

export function minimize(expected, actual) {
  const target = canonicalStringify(reconcile(expected, actual).differences);
  const items = canonicalItems(expected, actual);
  const count = items.length;

  const signatureOf = (picked) => {
    const subExpected = [];
    const subActual = [];
    for (const i of picked) {
      (items[i].side === 'expected' ? subExpected : subActual).push(items[i].entry);
    }
    return canonicalStringify(reconcile(subExpected, subActual).differences);
  };
  const interesting = (picked) => signatureOf(picked) === target;

  let chosen;
  let algorithm;
  if (count <= EXHAUSTIVE_LIMIT) {
    algorithm = 'exhaustive-lexicographic';
    chosen = null;
    for (let size = 1; size <= count && chosen === null; size += 1) {
      for (const combo of combinations(count, size)) {
        if (interesting(combo)) {
          chosen = combo;
          break;
        }
      }
    }
    if (chosen === null) chosen = [];
  } else {
    algorithm = 'greedy-one-minimal';
    // Partner links let the greedy search drop entries that only cancel each
    // other: cross-side exact matches and within-side reversal pairs. Singles
    // are still tried every pass, so the fixpoint is always 1-minimal.
    const partners = new Map(items.map((_, i) => [i, new Set()]));
    const link = (a, b) => {
      partners.get(a).add(b);
      partners.get(b).add(a);
    };
    const openByKey = new Map();
    items.forEach((item, i) => {
      if (item.entry.type !== 'normal') return;
      const key = `${item.side === 'expected' ? 'actual' : 'expected'}:${matchKey(item.entry)}`;
      if (!openByKey.has(key)) openByKey.set(key, []);
      openByKey.get(key).push(i);
    });
    items.forEach((item, i) => {
      if (item.entry.type !== 'normal') return;
      const key = `${item.side}:${matchKey(item.entry)}`;
      for (const j of openByKey.get(key) ?? []) link(i, j);
    });
    const normalIndexBySideId = new Map();
    items.forEach((item, i) => {
      if (item.entry.type === 'normal') normalIndexBySideId.set(`${item.side}:${item.entry.entryId}`, i);
    });
    items.forEach((item, i) => {
      if (item.entry.type !== 'reversal') return;
      const origin = normalIndexBySideId.get(`${item.side}:${item.entry.reversalOf}`);
      if (origin !== undefined) link(i, origin);
    });

    let current = new Set(items.map((_, i) => i));
    let changed = true;
    while (changed) {
      changed = false;
      for (const i of [...current]) {
        const trial = new Set(current);
        trial.delete(i);
        if (interesting(trial)) {
          current = trial;
          changed = true;
        }
      }
      for (const i of [...current]) {
        for (const j of partners.get(i)) {
          if (!current.has(i) || !current.has(j)) continue;
          const trial = new Set(current);
          trial.delete(i);
          trial.delete(j);
          if (interesting(trial)) {
            current = trial;
            changed = true;
          }
        }
      }
    }
    chosen = [...current].sort((a, b) => a - b);
  }

  const minimalExpected = [];
  const minimalActual = [];
  for (const i of chosen) {
    (items[i].side === 'expected' ? minimalExpected : minimalActual).push(items[i].entry);
  }
  return {
    algorithm,
    entryCount: count,
    subsetSize: chosen.length,
    indices: chosen,
    expected: minimalExpected,
    actual: minimalActual,
  };
}

export function analyze(input) {
  const { expected, actual } = validateRecon(input);
  const full = reconcile(expected, actual);
  const balanced = full.differences.length === 0;
  const reduction = balanced ? null : minimize(expected, actual);

  const minimal = balanced
    ? { expected: [], actual: [] }
    : { expected: reduction.expected, actual: reduction.actual };

  const certificate = balanced
    ? {
        balanced: true,
        algorithm: 'none',
        property: 'all-entries-matched',
        entryCount: expected.length + actual.length,
        subsetSize: 0,
      }
    : {
        balanced: false,
        algorithm: reduction.algorithm,
        property: 'minimal-subset-reproduces-differences',
        entryCount: reduction.entryCount,
        subsetSize: reduction.subsetSize,
        oneMinimal: true,
        cardinalityMinimal: reduction.algorithm === 'exhaustive-lexicographic',
        lexicographicallyMinimal: reduction.algorithm === 'exhaustive-lexicographic',
      };

  const result = {
    status: balanced ? 'BALANCED' : 'UNBALANCED',
    certificate,
    differences: full.differences,
    totals: full.totals,
    minimal,
  };
  result.replayHash = `sha256:${createHash('sha256')
    .update(canonicalStringify({
      differences: result.differences,
      minimal: result.minimal,
      totals: result.totals,
    }))
    .digest('hex')}`;
  return result;
}
