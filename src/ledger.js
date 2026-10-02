export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Tracks per-account balance and frozen (margin) amounts.
// balance === null means unlimited. All mutations go through applyBatch,
// which validates every op against a simulation first and only then
// applies them, so a batch is atomic: either all ops land or none do.
export class Ledger {
  constructor(accounts = {}) {
    this.accounts = new Map();
    for (const [name, balance] of Object.entries(accounts)) {
      this.accounts.set(name, { balance, frozen: 0 });
    }
  }

  ensure(name) {
    if (!this.accounts.has(name)) {
      this.accounts.set(name, { balance: null, frozen: 0 });
    }
  }

  setBalance(name, balance) {
    this.ensure(name);
    this.accounts.get(name).balance = balance;
  }

  frozenOf(name) {
    return this.accounts.get(name)?.frozen ?? 0;
  }

  #simulate(ops) {
    const frozen = new Map();
    for (const op of ops) {
      const acc = this.accounts.get(op.account) ?? { balance: null, frozen: 0 };
      const cur = frozen.get(op.account) ?? acc.frozen;
      if (op.op === 'release') {
        if (op.amount > cur + 1e-9) {
          throw new LedgerError(
            'INSUFFICIENT_FROZEN',
            `cannot release ${op.amount} from ${op.account}: only ${cur} frozen`,
          );
        }
        frozen.set(op.account, cur - op.amount);
      } else if (op.op === 'freeze') {
        if (acc.balance !== null && cur + op.amount > acc.balance + 1e-9) {
          throw new LedgerError(
            'INSUFFICIENT_FUNDS',
            `cannot freeze ${op.amount} on ${op.account}: balance ${acc.balance}, already frozen ${cur}`,
          );
        }
        frozen.set(op.account, cur + op.amount);
      } else {
        throw new LedgerError('BAD_OP', `unknown ledger op: ${op.op}`);
      }
    }
    return frozen;
  }

  applyBatch(ops) {
    const frozen = this.#simulate(ops); // throws before any mutation
    for (const [account, value] of frozen) {
      this.accounts.get(account).frozen = Math.round(value * 1e6) / 1e6;
    }
    return ops;
  }

  snapshot() {
    const out = {};
    for (const [name, acc] of [...this.accounts].sort()) {
      out[name] = { balance: acc.balance, frozen: acc.frozen };
    }
    return out;
  }
}
