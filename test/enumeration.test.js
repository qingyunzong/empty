'use strict';

// Exhaustive enumeration: for every operation sequence of length n <= 6 over a
// small alphabet, apply it to the library and to an independent oracle
// implementation of the same spec, then compare per-step exit codes and the
// resulting balances/statuses. A failed command never prunes the sequence:
// remaining operations are still applied (pending migrations are not treated
// as unsatisfiable).

const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, applyCommand, verifyState } = require('../src/machine');

const SEED = {
  A: { available: 120, frozen: 0, frozenLocked: 0 },
  B: { available: 50, frozen: 0, frozenLocked: 0 },
};
const TOTAL_MONEY = 170;

const OPS = [
  { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 100 },
  { type: 'reverse', txId: 't1' },
  { type: 'reverse', txId: 't1', amount: 40 },
  { type: 'reverseReversal', txId: 't1' },
  { type: 'freeze', account: 'B', amount: 60, reason: 'reversal-compensation' },
  { type: 'unfreeze', account: 'B', amount: 30 },
];

// ---- Independent oracle -------------------------------------------------

function oracleSeed() {
  return {
    accounts: {
      A: { av: 120, fr: 0, fl: 0 },
      B: { av: 50, fr: 0, fl: 0 },
    },
    tx: null,
  };
}

function oracleDebit(acct, amount) {
  const useAv = Math.min(acct.av, amount);
  let rest = amount - useAv;
  const useFrU = Math.min(acct.fr - acct.fl, rest);
  rest -= useFrU;
  const useFrL = Math.min(acct.fl, rest);
  rest -= useFrL;
  if (rest > 0) return null;
  acct.av -= useAv;
  acct.fr -= useFrU + useFrL;
  acct.fl -= useFrL;
  return { av: useAv, frU: useFrU, frL: useFrL };
}

function oracleApply(st, op) {
  switch (op.type) {
    case 'transfer': {
      if (st.tx) return 15;
      if (!(op.amount > 0)) return 16;
      if (!oracleDebit(st.accounts[op.from], op.amount)) return 16;
      st.accounts[op.to].av += op.amount;
      st.tx = { amount: op.amount, rev: 0, status: 'POSTED', from: op.from, to: op.to, parts: [] };
      return 0;
    }
    case 'reverse': {
      if (!st.tx || st.tx.status !== 'POSTED') return 15;
      const remaining = st.tx.amount - st.tx.rev;
      const amount = op.amount === undefined ? remaining : op.amount;
      if (!(amount > 0) || amount > remaining) return 16;
      const parts = oracleDebit(st.accounts[st.tx.to], amount);
      if (!parts) return 16;
      st.accounts[st.tx.from].av += amount;
      st.tx.parts.push(parts);
      st.tx.rev += amount;
      if (st.tx.rev === st.tx.amount) st.tx.status = 'REVERSED';
      return 0;
    }
    case 'reverseReversal': {
      if (!st.tx || st.tx.status !== 'REVERSED') return 15;
      const total = st.tx.rev;
      if (!oracleDebit(st.accounts[st.tx.from], total)) return 16;
      const to = st.accounts[st.tx.to];
      for (const p of st.tx.parts) {
        to.av += p.av;
        to.fr += p.frU + p.frL;
        to.fl += p.frL;
      }
      st.tx.status = 'RESTORED';
      return 0;
    }
    case 'freeze': {
      const acct = st.accounts[op.account];
      if (!(op.amount > 0) || op.amount > acct.av) return 16;
      acct.av -= op.amount;
      acct.fr += op.amount;
      if (op.reason === 'reversal-compensation') acct.fl += op.amount;
      return 0;
    }
    case 'unfreeze': {
      const acct = st.accounts[op.account];
      if (!(op.amount > 0) || op.amount > acct.fr - acct.fl) return 16;
      acct.fr -= op.amount;
      acct.av += op.amount;
      return 0;
    }
    default:
      return 17;
  }
}

// ---- Comparison helpers -------------------------------------------------

function snapshotLibrary(state) {
  const tx = state.transactions.t1;
  return {
    A: state.accounts.A,
    B: state.accounts.B,
    tx: tx ? { status: tx.status, rev: tx.reversedAmount } : null,
  };
}

function snapshotOracle(st) {
  return {
    A: { available: st.accounts.A.av, frozen: st.accounts.A.fr, frozenLocked: st.accounts.A.fl },
    B: { available: st.accounts.B.av, frozen: st.accounts.B.fr, frozenLocked: st.accounts.B.fl },
    tx: st.tx ? { status: st.tx.status, rev: st.tx.rev } : null,
  };
}

test('enumerate all operation sequences of length n<=6 and compare with oracle', () => {
  const base = OPS.length;
  const maxLen = 6;
  let sequences = 0;
  let steps = 0;

  for (let len = 1; len <= maxLen; len += 1) {
    const total = base ** len;
    for (let code = 0; code < total; code += 1) {
      const seq = [];
      let n = code;
      for (let i = 0; i < len; i += 1) {
        seq.push(OPS[n % base]);
        n = Math.floor(n / base);
      }

      const libState = initialState();
      libState.accounts = JSON.parse(JSON.stringify(SEED));
      const oracle = oracleSeed();

      for (const op of seq) {
        const result = applyCommand(libState, op);
        const oracleCode = oracleApply(oracle, op);
        assert.equal(
          result.code,
          oracleCode,
          `exit code mismatch for sequence ${JSON.stringify(seq)} at op ${JSON.stringify(op)}`,
        );
        assert.deepEqual(snapshotLibrary(libState), snapshotOracle(oracle));
        const money = Object.values(libState.accounts)
          .reduce((sum, a) => sum + a.available + a.frozen, 0);
        assert.equal(money, TOTAL_MONEY, 'money conservation violated');
        steps += 1;
      }
      assert.deepEqual(verifyState(libState), { ok: true, errors: [] });
      sequences += 1;
    }
  }

  assert.equal(sequences, 6 + 36 + 216 + 1296 + 7776 + 46656);
  assert.ok(steps > 0);
});
