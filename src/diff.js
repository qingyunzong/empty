import { ReconError } from './errors.js';

export const DIFF_KINDS = Object.freeze([
  'missing_in_snapshot',
  'missing_in_ledger',
  'mismatch',
  'duplicate',
]);

const COMPARED_FIELDS = Object.freeze(['account', 'day', 'merchant', 'amount', 'currency']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateEntry(entry, where) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ReconError('BAD_DIFF', `${where}: entry must be an object`);
  }
  for (const field of COMPARED_FIELDS.concat('id')) {
    if (entry[field] === undefined) {
      throw new ReconError('BAD_DIFF', `${where}: entry ${JSON.stringify(entry.id)} missing field "${field}"`);
    }
  }
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new ReconError('BAD_DIFF', `${where}: id must be a non-empty string`);
  }
  if (!Number.isInteger(entry.amount)) {
    throw new ReconError('BAD_DIFF', `${where}: amount must be an integer (minor units), got ${JSON.stringify(entry.amount)}`);
  }
  if (typeof entry.day !== 'string' || !DAY_RE.test(entry.day)) {
    throw new ReconError('BAD_DIFF', `${where}: day must be YYYY-MM-DD, got ${JSON.stringify(entry.day)}`);
  }
}

function mismatchFields(ledgerEntry, snapshotEntry) {
  const fields = [];
  for (const field of COMPARED_FIELDS) {
    if (JSON.stringify(ledgerEntry[field]) !== JSON.stringify(snapshotEntry[field])) fields.push(field);
  }
  return fields;
}

function sortDiffs(diffs) {
  return diffs.sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
}

// Primary classifier: Map-based, O(n).
export function classifyDiffs(ledger, snapshot) {
  ledger.forEach((e, i) => validateEntry(e, `ledger[${i}]`));
  snapshot.forEach((e, i) => validateEntry(e, `snapshot[${i}]`));

  const ledgerById = new Map();
  const snapshotById = new Map();
  const ledgerCount = new Map();
  const snapshotCount = new Map();
  for (const e of ledger) {
    ledgerCount.set(e.id, (ledgerCount.get(e.id) ?? 0) + 1);
    if (!ledgerById.has(e.id)) ledgerById.set(e.id, e);
  }
  for (const e of snapshot) {
    snapshotCount.set(e.id, (snapshotCount.get(e.id) ?? 0) + 1);
    if (!snapshotById.has(e.id)) snapshotById.set(e.id, e);
  }

  const diffs = [];
  for (const [id, entry] of ledgerById) {
    if (!snapshotById.has(id)) diffs.push({ kind: 'missing_in_snapshot', id, entry });
  }
  for (const [id, entry] of snapshotById) {
    if (!ledgerById.has(id)) diffs.push({ kind: 'missing_in_ledger', id, entry });
  }
  for (const [id, ledgerEntry] of ledgerById) {
    const snapEntry = snapshotById.get(id);
    if (!snapEntry) continue;
    const fields = mismatchFields(ledgerEntry, snapEntry);
    if (fields.length > 0) diffs.push({ kind: 'mismatch', id, fields, ledger: ledgerEntry, snapshot: snapEntry });
  }
  for (const [id, count] of ledgerCount) {
    if (count > 1) diffs.push({ kind: 'duplicate', id, side: 'ledger', occurrences: count, entry: ledgerById.get(id) });
  }
  for (const [id, count] of snapshotCount) {
    if (count > 1) diffs.push({ kind: 'duplicate', id, side: 'snapshot', occurrences: count, entry: snapshotById.get(id) });
  }
  return sortDiffs(diffs);
}

// Reference classifier: deliberately naive O(n^2) nested scans, no Map.
// Used by tests to cross-check classifyDiffs for n <= 8.
export function classifyDiffsReference(ledger, snapshot) {
  ledger.forEach((e, i) => validateEntry(e, `ledger[${i}]`));
  snapshot.forEach((e, i) => validateEntry(e, `snapshot[${i}]`));

  const firstIndex = (list, id) => {
    for (let i = 0; i < list.length; i += 1) if (list[i].id === id) return i;
    return -1;
  };
  const countOf = (list, id) => {
    let n = 0;
    for (const e of list) if (e.id === id) n += 1;
    return n;
  };

  const diffs = [];
  const seen = [];
  for (const e of ledger) {
    if (seen.includes(e.id)) continue;
    seen.push(e.id);
    if (firstIndex(snapshot, e.id) === -1) diffs.push({ kind: 'missing_in_snapshot', id: e.id, entry: e });
  }
  seen.length = 0;
  for (const e of snapshot) {
    if (seen.includes(e.id)) continue;
    seen.push(e.id);
    if (firstIndex(ledger, e.id) === -1) diffs.push({ kind: 'missing_in_ledger', id: e.id, entry: e });
  }
  seen.length = 0;
  for (const e of ledger) {
    if (seen.includes(e.id)) continue;
    seen.push(e.id);
    const j = firstIndex(snapshot, e.id);
    if (j === -1) continue;
    const fields = mismatchFields(e, snapshot[j]);
    if (fields.length > 0) diffs.push({ kind: 'mismatch', id: e.id, fields, ledger: e, snapshot: snapshot[j] });
  }
  seen.length = 0;
  for (const e of ledger) {
    if (seen.includes(e.id)) continue;
    seen.push(e.id);
    const n = countOf(ledger, e.id);
    if (n > 1) diffs.push({ kind: 'duplicate', id: e.id, side: 'ledger', occurrences: n, entry: e });
  }
  seen.length = 0;
  for (const e of snapshot) {
    if (seen.includes(e.id)) continue;
    seen.push(e.id);
    const n = countOf(snapshot, e.id);
    if (n > 1) diffs.push({ kind: 'duplicate', id: e.id, side: 'snapshot', occurrences: n, entry: e });
  }
  return sortDiffs(diffs);
}

const SEVERITY_BY_KIND = Object.freeze({
  mismatch: 3,
  missing_in_snapshot: 2,
  missing_in_ledger: 2,
  duplicate: 1,
});

// Convert diffs to repair tasks. Ledger-side duplicates are data-quality
// findings only (the snapshot cannot fix them) and produce no task.
export function diffsToTasks(diffs) {
  const tasks = [];
  for (const diff of diffs) {
    const base = diff.entry ?? diff.ledger ?? diff.snapshot;
    const task = {
      id: `repair:${diff.kind}:${diff.id}`,
      diffId: diff.id,
      kind: diff.kind,
      account: base.account,
      day: base.day,
      merchant: base.merchant,
      domain: `${base.account}@${base.day}`,
      severity: SEVERITY_BY_KIND[diff.kind],
      deadline: base.day,
      undoable: true,
    };
    const lateSource = diff.entry ?? diff.ledger;
    if (lateSource && lateSource.late) task.late = true;
    if (lateSource && lateSource.supersedes) task.supersedes = lateSource.supersedes;
    if (diff.kind === 'missing_in_snapshot') {
      task.repair = { action: 'insert', entry: diff.entry };
    } else if (diff.kind === 'missing_in_ledger') {
      task.repair = { action: 'remove', id: diff.id };
    } else if (diff.kind === 'mismatch') {
      const set = {};
      for (const f of diff.fields) set[f] = diff.ledger[f];
      task.repair = { action: 'update', id: diff.id, set };
    } else if (diff.kind === 'duplicate' && diff.side === 'snapshot') {
      task.repair = { action: 'dedupe', id: diff.id };
    } else {
      continue; // ledger-side duplicate: no snapshot repair
    }
    tasks.push(task);
  }
  return tasks;
}

// Apply one repair to a snapshot entry list, returning a NEW list.
// Throws BAD_DIFF when the repair does not match the snapshot state.
export function applyRepair(entries, repair) {
  if (repair === null || typeof repair !== 'object') {
    throw new ReconError('BAD_DIFF', 'repair must be an object');
  }
  switch (repair.action) {
    case 'insert': {
      validateEntry(repair.entry, 'repair.insert');
      if (entries.some((e) => e.id === repair.entry.id)) {
        throw new ReconError('BAD_DIFF', `insert: id ${repair.entry.id} already present in snapshot`);
      }
      return [...entries, repair.entry];
    }
    case 'remove': {
      if (!entries.some((e) => e.id === repair.id)) {
        throw new ReconError('BAD_DIFF', `remove: id ${repair.id} not present in snapshot`);
      }
      return entries.filter((e) => e.id !== repair.id);
    }
    case 'update': {
      const idx = entries.findIndex((e) => e.id === repair.id);
      if (idx === -1) throw new ReconError('BAD_DIFF', `update: id ${repair.id} not present in snapshot`);
      const next = entries.slice();
      next[idx] = { ...next[idx], ...repair.set };
      validateEntry(next[idx], 'repair.update');
      return next;
    }
    case 'dedupe': {
      const occurrences = entries.filter((e) => e.id === repair.id).length;
      if (occurrences < 2) {
        throw new ReconError('BAD_DIFF', `dedupe: id ${repair.id} has ${occurrences} occurrence(s)`);
      }
      let kept = false;
      return entries.filter((e) => {
        if (e.id !== repair.id) return true;
        if (!kept) { kept = true; return true; }
        return false;
      });
    }
    default:
      throw new ReconError('BAD_DIFF', `unknown repair action ${JSON.stringify(repair.action)}`);
  }
}
