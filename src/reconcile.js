import { stableStringify } from './stable-json.js';

export class InvalidReconError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidReconError';
    this.code = 'INVALID_RECON';
  }
}

function fail(message) {
  throw new InvalidReconError(message);
}

function validateSide(entries, side) {
  const byId = new Map();
  entries.forEach((entry, index) => {
    const where = `${side}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${where} must be an object`);
    }
    if (typeof entry.entryId !== 'string' || entry.entryId.length === 0) {
      fail(`${where} has invalid entryId`);
    }
    if (typeof entry.account !== 'string' || entry.account.length === 0) {
      fail(`${where} ('${entry.entryId}') has invalid account`);
    }
    if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) {
      fail(`${where} ('${entry.entryId}') has invalid amount`);
    }
    if (entry.type !== 'normal' && entry.type !== 'reversal') {
      fail(`${where} ('${entry.entryId}') has invalid type '${entry.type}'`);
    }
    if (byId.has(entry.entryId)) {
      fail(`duplicate entryId '${entry.entryId}' in ${side}`);
    }
    if (entry.type === 'normal') {
      if (entry.amount < 0) {
        fail(`negative amount in ${side} entry '${entry.entryId}'`);
      }
    } else if (typeof entry.reversalOf !== 'string' || entry.reversalOf.length === 0) {
      fail(`${where} ('${entry.entryId}') reversal requires reversalOf`);
    }
    byId.set(entry.entryId, entry);
  });
  for (const entry of entries) {
    if (entry.type !== 'reversal') continue;
    if (entry.reversalOf === entry.entryId) {
      fail(`reversal chain: '${entry.entryId}' references itself`);
    }
    const target = byId.get(entry.reversalOf);
    if (target && target.type === 'reversal') {
      fail(`reversal chain: '${entry.entryId}' references reversal '${target.entryId}'`);
    }
  }
  return entries;
}

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('input must be an object with expected and actual arrays');
  }
  for (const side of ['expected', 'actual']) {
    if (!Array.isArray(input[side])) {
      fail(`'${side}' must be an array`);
    }
  }
  return {
    expected: validateSide(input.expected, 'expected'),
    actual: validateSide(input.actual, 'actual'),
  };
}

function emptyDiffs() {
  return { missing: [], extra: [], amountMismatch: [], invalidReversal: [] };
}

// Pair reversals with their originals within one side. Valid pairs cancel
// (net zero) and leave the matching pool; invalid ones become diffs and the
// reversal is excluded from normal matching. An unmatched original is never
// offset by its reversal alone: pairing is strictly per-side.
function extractNormalPool(entries, side, diffs) {
  const byId = new Map(entries.map((e) => [e.entryId, e]));
  const cancelled = new Set();
  for (const entry of entries) {
    if (entry.type !== 'reversal') continue;
    const original = byId.get(entry.reversalOf);
    if (!original) {
      diffs.invalidReversal.push({
        side,
        entry,
        reason: `reversalOf '${entry.reversalOf}' not found in ${side}`,
      });
    } else if (cancelled.has(original.entryId)) {
      diffs.invalidReversal.push({
        side,
        entry,
        reason: `original '${original.entryId}' already reversed`,
      });
    } else if (original.amount + entry.amount !== 0) {
      diffs.invalidReversal.push({
        side,
        entry,
        reason: `amount ${entry.amount} is not the opposite of original ${original.amount}`,
      });
    } else {
      cancelled.add(original.entryId);
      cancelled.add(entry.entryId);
    }
  }
  return entries.filter((e) => e.type !== 'reversal' && !cancelled.has(e.entryId));
}

export function reconcile(expected, actual) {
  const diffs = emptyDiffs();
  const expectedPool = extractNormalPool(expected, 'expected', diffs);
  const actualPool = extractNormalPool(actual, 'actual', diffs);

  const actualById = new Map(actualPool.map((e) => [e.entryId, e]));
  for (const exp of expectedPool) {
    const act = actualById.get(exp.entryId);
    if (!act) {
      diffs.missing.push(exp);
      continue;
    }
    actualById.delete(exp.entryId);
    if (act.account === exp.account && act.amount === exp.amount) {
      continue;
    }
    if (act.account === exp.account) {
      diffs.amountMismatch.push({ expected: exp, actual: act });
    } else {
      diffs.missing.push(exp);
      diffs.extra.push(act);
    }
  }
  for (const act of actualById.values()) {
    diffs.extra.push(act);
  }
  const byId = (x, y) => (x.entryId < y.entryId ? -1 : x.entryId > y.entryId ? 1 : 0);
  diffs.missing.sort(byId);
  diffs.extra.sort(byId);
  diffs.amountMismatch.sort((x, y) => byId(x.expected, y.expected));
  diffs.invalidReversal.sort((x, y) => byId(x.entry, y.entry));
  return diffs;
}

export function isBalanced(diffs) {
  return (
    diffs.missing.length === 0 &&
    diffs.extra.length === 0 &&
    diffs.amountMismatch.length === 0 &&
    diffs.invalidReversal.length === 0
  );
}

export function totalImpact(diffs) {
  let impact = 0;
  for (const e of diffs.missing) impact -= e.amount;
  for (const e of diffs.extra) impact += e.amount;
  for (const m of diffs.amountMismatch) impact += m.actual.amount - m.expected.amount;
  for (const r of diffs.invalidReversal) {
    impact += r.side === 'actual' ? r.entry.amount : -r.entry.amount;
  }
  return impact;
}

export function signature(diffs) {
  return stableStringify(diffs);
}
