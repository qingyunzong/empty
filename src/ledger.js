import { parseAmount, formatAmount } from './amount.js';
import { stateError } from './errors.js';

export const ENTRY_STATUSES = new Set([
  'SETTLED', 'PENDING', 'LOCKED', 'CANCEL_REQUESTED', 'REVERSED', 'COMPENSATED',
]);

const NON_POSTED = new Set(['PENDING', 'CANCEL_REQUESTED']);

export function loadLedger(json) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw stateError('ledger must be a JSON object');
  }
  const currentDay = json.currentDay;
  if (!Number.isInteger(currentDay) || currentDay < 0) {
    throw stateError('ledger.currentDay must be a non-negative integer');
  }
  if (!Array.isArray(json.entries)) throw stateError('ledger.entries must be an array');
  const entries = json.entries.map((e, i) => normalizeEntry(e, i));
  const ledger = {
    currentDay,
    entries,
    revocations: Array.isArray(json.revocations) ? json.revocations.map((r) => ({ ...r })) : [],
  };
  validateTxns(ledger);
  return ledger;
}

function normalizeEntry(e, i) {
  const where = `entries[${i}]`;
  if (e == null || typeof e !== 'object') throw stateError(`${where}: must be an object`);
  for (const f of ['id', 'txnId', 'account', 'dc', 'amount', 'status', 'day']) {
    if (e[f] === undefined) throw stateError(`${where}: missing field '${f}'`);
  }
  if (e.dc !== 'debit' && e.dc !== 'credit') throw stateError(`${where}: dc must be debit|credit`);
  if (!ENTRY_STATUSES.has(e.status)) throw stateError(`${where}: unknown status ${e.status}`);
  if (!Number.isInteger(e.day) || e.day < 0) throw stateError(`${where}: day must be a non-negative integer`);
  let amountCents;
  try {
    amountCents = parseAmount(e.amount);
  } catch {
    throw stateError(`${where}: invalid amount ${JSON.stringify(e.amount)}`);
  }
  if (amountCents <= 0) throw stateError(`${where}: amount must be positive`);
  const out = {
    id: String(e.id),
    txnId: String(e.txnId),
    account: String(e.account),
    dc: e.dc,
    amountCents,
    status: e.status,
    day: e.day,
  };
  if (e.ref != null) out.ref = String(e.ref);
  if (e.revId != null) out.revId = String(e.revId);
  if (e.kind != null) out.kind = String(e.kind);
  return out;
}

function validateTxns(ledger) {
  const byTxn = new Map();
  for (const e of ledger.entries) {
    if (!byTxn.has(e.txnId)) byTxn.set(e.txnId, []);
    byTxn.get(e.txnId).push(e);
  }
  for (const [txnId, entries] of byTxn) {
    const originals = entries.filter((e) => e.kind == null);
    if (originals.length === 0) throw stateError(`txn ${txnId}: no original entries`, { txnId });
    const status = originals[0].status;
    for (const e of originals) {
      if (e.status !== status) {
        throw stateError(`txn ${txnId}: mixed entry statuses (${status} vs ${e.status})`, { txnId });
      }
    }
    let debits = 0;
    let credits = 0;
    for (const e of originals) {
      if (e.dc === 'debit') debits += e.amountCents;
      else credits += e.amountCents;
    }
    if (debits === 0 || credits === 0 || debits !== credits) {
      throw stateError(
        `txn ${txnId}: unbalanced entries (debits=${debits} credits=${credits}); debit/credit must pair`,
        { txnId },
      );
    }
  }
}

export function txnEntries(ledger, txnId) {
  return ledger.entries.filter((e) => e.txnId === txnId);
}

export function allTxnIds(ledger) {
  const seen = new Set();
  const ids = [];
  for (const e of ledger.entries) {
    if (!seen.has(e.txnId)) {
      seen.add(e.txnId);
      ids.push(e.txnId);
    }
  }
  return ids;
}

export function applyEffect(ledger, effect) {
  const dup = ledger.revocations.some(
    (r) => r.revId === effect.revId && r.txnId === effect.txnId,
  );
  if (dup) return 'skipped';
  for (const sc of effect.statusChanges ?? []) {
    const entry = ledger.entries.find((e) => e.id === sc.id);
    if (!entry) throw stateError(`effect references unknown entry ${sc.id}`, { txnId: effect.txnId });
    entry.status = sc.to;
  }
  for (const ne of effect.newEntries ?? []) {
    if (ledger.entries.some((e) => e.id === ne.id)) continue;
    ledger.entries.push({ ...ne });
  }
  ledger.revocations.push({ ...effect.revocation });
  return 'applied';
}

export function balances(ledger) {
  const bal = new Map();
  for (const e of ledger.entries) {
    if (NON_POSTED.has(e.status)) continue;
    const signed = e.dc === 'debit' ? e.amountCents : -e.amountCents;
    bal.set(e.account, (bal.get(e.account) ?? 0) + signed);
  }
  return bal;
}

export function balancesObject(ledger) {
  const bal = balances(ledger);
  const out = {};
  for (const k of [...bal.keys()].sort()) out[k] = bal.get(k);
  return out;
}

export function serializeLedger(ledger) {
  return {
    currentDay: ledger.currentDay,
    entries: ledger.entries.map((e) => {
      const out = {
        id: e.id,
        txnId: e.txnId,
        account: e.account,
        dc: e.dc,
        amount: formatAmount(e.amountCents),
        status: e.status,
        day: e.day,
      };
      if (e.ref != null) out.ref = e.ref;
      if (e.revId != null) out.revId = e.revId;
      if (e.kind != null) out.kind = e.kind;
      return out;
    }),
    revocations: ledger.revocations.map((r) => ({ ...r })),
  };
}
