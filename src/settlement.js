import { StoreError } from './store.js';

export const SLIP_STATUS = Object.freeze({
  OPEN: 'OPEN',
  SETTLED: 'SETTLED',
  CANCELLED: 'CANCELLED',
});

export const slipKey = (id) => `settle:${id}`;
export const acctKey = (merchantId) => `acct:${merchantId}`;
export const reversalKey = (id) => `reversal:${id}`;
export const entryKey = (id, tag) => `entry:${id}:${tag}`;

export function ensureAccount(tx, merchantId) {
  const key = acctKey(merchantId);
  const acct = tx.get(key);
  if (acct === undefined) {
    const created = { merchantId, balance: 0 };
    tx.put(key, created);
    return created;
  }
  return acct;
}

export function openSlip(tx, { id, merchantId, amount }) {
  const key = slipKey(id);
  if (tx.get(key) !== undefined) {
    throw new StoreError('E_EXISTS', `slip ${id} already exists`);
  }
  ensureAccount(tx, merchantId);
  tx.put(key, { id, merchantId, amount, status: SLIP_STATUS.OPEN });
}

// Settle an OPEN slip: credit the merchant account and record a ledger entry.
export function settleSlip(tx, slipId) {
  const key = slipKey(slipId);
  const slip = tx.get(key);
  if (slip === undefined) throw new StoreError('E_NOT_FOUND', `slip ${slipId} not found`);
  if (slip.status !== SLIP_STATUS.OPEN) {
    throw new StoreError('E_STATE', `cannot settle slip ${slipId} in state ${slip.status}`);
  }
  const acct = ensureAccount(tx, slip.merchantId);
  tx.put(acctKey(slip.merchantId), { ...acct, balance: acct.balance + slip.amount });
  tx.put(entryKey(slipId, 'settle'), {
    type: 'settle',
    slipId,
    debit: `clearing:${slip.merchantId}`,
    credit: acctKey(slip.merchantId),
    amount: slip.amount,
  });
  tx.put(key, { ...slip, status: SLIP_STATUS.SETTLED });
}

// Cancel an OPEN slip: append a reversal record plus debit/credit reversal
// entries. History is never overwritten; the slip gets a new CANCELLED
// version while older versions stay readable via readAt / get --at.
export function cancelSlip(tx, slipId) {
  const key = slipKey(slipId);
  const slip = tx.get(key);
  if (slip === undefined) throw new StoreError('E_NOT_FOUND', `slip ${slipId} not found`);
  if (slip.status !== SLIP_STATUS.OPEN) {
    throw new StoreError('E_STATE', `cannot cancel slip ${slipId} in state ${slip.status}`);
  }
  tx.put(reversalKey(slipId), {
    kind: 'cancel',
    slipId,
    merchantId: slip.merchantId,
    amount: slip.amount,
  });
  tx.put(entryKey(slipId, 'reversal:debit'), {
    type: 'reversal',
    leg: 'debit',
    slipId,
    account: acctKey(slip.merchantId),
    amount: -slip.amount,
  });
  tx.put(entryKey(slipId, 'reversal:credit'), {
    type: 'reversal',
    leg: 'credit',
    slipId,
    account: `clearing:${slip.merchantId}`,
    amount: slip.amount,
  });
  tx.put(key, { ...slip, status: SLIP_STATUS.CANCELLED });
}
