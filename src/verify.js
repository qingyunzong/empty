'use strict';

const { EXIT } = require('./errors');
const { normalizeSet, accountTotals } = require('./model');

function deltaOf(totals) {
  const out = new Map();
  for (const [account, t] of totals) {
    out.set(account, { net: t.debit - t.credit, freeze: t.freeze });
  }
  return out;
}

function verifyMigration(rawOld, rawNew, proof) {
  const oldTable = normalizeSet(rawOld, 'old');
  const newTable = normalizeSet(rawNew, 'new');

  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) {
    return { ok: false, failure: { invariant: 'schema', code: EXIT.GENERIC, message: 'proof must be an object' } };
  }
  if (proof.perAccountDelta === null || typeof proof.perAccountDelta !== 'object' || Array.isArray(proof.perAccountDelta)) {
    return { ok: false, failure: { invariant: 'schema', code: EXIT.GENERIC, message: 'proof.perAccountDelta must be an object' } };
  }
  if (proof.conservation === null || typeof proof.conservation !== 'object' || Array.isArray(proof.conservation)) {
    return { ok: false, failure: { invariant: 'schema', code: EXIT.GENERIC, message: 'proof.conservation must be an object' } };
  }
  if (!Array.isArray(proof.forbiddenOps)) {
    return { ok: false, failure: { invariant: 'schema', code: EXIT.GENERIC, message: 'proof.forbiddenOps must be an array' } };
  }

  const oldDelta = deltaOf(accountTotals(oldTable.values()));
  const newDelta = deltaOf(accountTotals(newTable.values()));
  const accounts = new Set([...oldDelta.keys(), ...newDelta.keys(), ...Object.keys(proof.perAccountDelta)]);
  for (const account of [...accounts].sort()) {
    const before = oldDelta.get(account) || { net: 0, freeze: 0 };
    const after = newDelta.get(account) || { net: 0, freeze: 0 };
    const actual = { net: after.net - before.net, freeze: after.freeze - before.freeze };
    const declared = proof.perAccountDelta[account] || { net: 0, freeze: 0 };
    if (declared.net !== actual.net || declared.freeze !== actual.freeze) {
      return {
        ok: false,
        failure: {
          invariant: 'conservation',
          code: EXIT.CONSERVATION,
          account,
          message: `conservation mismatch for account=${account}: declared delta net=${declared.net} freeze=${declared.freeze}, actual delta net=${actual.net} freeze=${actual.freeze}`,
        },
      };
    }
  }

  for (const instr of newTable.values()) {
    const before = oldTable.get(instr.id);
    if (!before || before.state !== 'SETTLED') continue;
    if (
      instr.debit !== before.debit ||
      instr.credit !== before.credit ||
      instr.freeze !== before.freeze ||
      instr.state !== 'SETTLED'
    ) {
      return {
        ok: false,
        failure: {
          invariant: 'settledProtection',
          code: EXIT.SETTLED_AMOUNT,
          account: instr.account,
          message: `SETTLED instruction ${instr.id} was modified (account=${instr.account})`,
        },
      };
    }
  }

  if (proof.forbiddenOps.length !== 0) {
    return {
      ok: false,
      failure: {
        invariant: 'forbiddenOps',
        code: EXIT.GENERIC,
        message: `proof lists ${proof.forbiddenOps.length} forbidden op(s)`,
      },
    };
  }

  return { ok: true, failure: null };
}

module.exports = { verifyMigration };
