'use strict';

const { StoreError } = require('./store');

const CLEARING_ACCOUNT = 'clearing';

function settleKey(id) {
  return `settle:${id}`;
}

function reversalKey(id) {
  return `reversal:${id}`;
}

function accountKey(id) {
  return `account:${id}`;
}

// Cancel an OPEN settlement slip inside `tx`. Writes a reversal record
// plus double-entry reversal postings (debit merchant, credit clearing),
// and flips the slip to CANCELLED as a new version — history is never
// overwritten. All writes land in the same atomic commit, so a failed
// cancel can never leave a half-posted entry behind.
async function cancelSlip(tx, slipId) {
  const sKey = settleKey(slipId);
  const slip = await tx.get(sKey);
  if (slip === undefined) {
    throw new StoreError('E_NOT_FOUND', `settlement slip "${slipId}" not found`);
  }
  if (slip.status !== 'OPEN') {
    throw new StoreError('E_INVALID_STATE', `settlement slip "${slipId}" is ${slip.status}, not OPEN`);
  }
  const rKey = reversalKey(slipId);
  if ((await tx.get(rKey)) !== undefined) {
    throw new StoreError('E_INVALID_STATE', `reversal for "${slipId}" already exists`);
  }
  if (typeof slip.merchant !== 'string' || typeof slip.amount !== 'number') {
    throw new StoreError('E_INVALID_STATE', `settlement slip "${slipId}" lacks merchant/amount`);
  }

  const merchantKey = accountKey(slip.merchant);
  const clearingKey = accountKey(CLEARING_ACCOUNT);
  const merchant = (await tx.get(merchantKey)) || { balance: 0 };
  const clearing = (await tx.get(clearingKey)) || { balance: 0 };

  const entries = [
    { account: slip.merchant, side: 'debit', amount: slip.amount },
    { account: CLEARING_ACCOUNT, side: 'credit', amount: slip.amount },
  ];

  tx.put(rKey, { id: slipId, slip: sKey, entries, kind: 'cancel' });
  tx.put(sKey, { ...slip, status: 'CANCELLED', reversedBy: rKey });
  tx.put(merchantKey, { ...merchant, balance: merchant.balance - slip.amount });
  tx.put(clearingKey, { ...clearing, balance: clearing.balance + slip.amount });
}

module.exports = { cancelSlip, settleKey, reversalKey, accountKey, CLEARING_ACCOUNT };
