import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { CONFLICT, NoAccountError, AccountExistsError } from './errors.js';

const acctKey = (name) => `acct/${name}`;
const USAGE_PREFIX = 'usage/';

// Budget domain on top of the MVCC store. A debit and its usage record are
// written in the same transaction, so they commit or abort together.
export class BudgetService {
  constructor(storeOrDir) {
    this.store = typeof storeOrDir === 'string' ? Store.open(storeOrDir) : storeOrDir;
  }

  createAccount(name, balance) {
    const tx = this.store.begin();
    if (tx.get(acctKey(name)) !== undefined) {
      throw new AccountExistsError(`account "${name}" already exists`);
    }
    tx.put(acctKey(name), { name, balance });
    return tx.commit();
  }

  // Debit `amount` from `name` and write a usage record, atomically.
  // Retries on CONFLICT up to `retries` times; BUDGET_EXCEEDED / NO_ACCOUNT
  // are terminal.
  async debit(name, amount, note = '', { retries = 0 } = {}) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`debit amount must be a positive number, got ${amount}`);
    }
    let attempt = 0;
    for (;;) {
      const tx = this.store.begin();
      const acct = tx.get(acctKey(name));
      if (acct === undefined) throw new NoAccountError(`account "${name}" does not exist`);
      tx.debit(acctKey(name), amount);
      tx.put(`${USAGE_PREFIX}${randomUUID()}`, { account: name, amount, note, ts: Date.now() });
      try {
        const txid = await tx.commit();
        return { txid, balance: acct.balance - amount };
      } catch (err) {
        if (err.code === CONFLICT && attempt < retries) {
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  balance(name) {
    const tx = this.store.begin();
    const acct = tx.get(acctKey(name));
    if (acct === undefined) throw new NoAccountError(`account "${name}" does not exist`);
    return acct.balance;
  }

  usage(account = null) {
    const tx = this.store.begin();
    return this.store
      .scanAt(tx.snapshot, USAGE_PREFIX)
      .map(([key, v]) => ({ key, ...v }))
      .filter((r) => account === null || r.account === account);
  }

  history() {
    return this.store.history;
  }
}
