import { InvalidInput } from './errors.js';

export const OP_TYPES = ['reserve', 'settle', 'cancel'];

// Payment-limit ledger.
// - reserve: holds (amount) of an account's available limit; creates an open hold.
// - settle:  converts an open hold into a real debit (held -= amount, balance -= amount).
// - cancel:  releases an open hold (held -= amount), restoring available limit.
// Rejections (insufficient funds, frozen account, hold not open/found) never
// mutate state: validation happens fully before any write.
export class Ledger {
  constructor(accounts) {
    this.accounts = accounts.map((a) => ({
      id: a.id,
      balance: a.balance,
      held: a.held ?? 0,
      frozen: a.frozen ?? false,
    }));
    this.holds = new Map(); // holdId -> { id, account, amount, state }
    this.holdSeq = 0;
  }

  #account(id) {
    const acc = this.accounts.find((a) => a.id === id);
    if (!acc) throw new InvalidInput(`unknown account: ${id}`);
    return acc;
  }

  apply(op) {
    if (!op || typeof op !== 'object') throw new InvalidInput('op must be an object');
    switch (op.type) {
      case 'reserve':
        return this.#reserve(op);
      case 'settle':
        return this.#settle(op);
      case 'cancel':
        return this.#cancel(op);
      default:
        throw new InvalidInput(`unknown op type: ${op.type}`);
    }
  }

  #reserve(op) {
    if (typeof op.account !== 'string') throw new InvalidInput('reserve.account must be a string');
    if (!Number.isInteger(op.amount) || op.amount <= 0) {
      throw new InvalidInput(`reserve.amount must be a positive integer, got ${op.amount}`);
    }
    const acc = this.#account(op.account);
    if (acc.frozen) return { status: 'rejected', reason: 'account_frozen' };
    if (acc.balance - acc.held < op.amount) {
      return { status: 'rejected', reason: 'insufficient_funds' };
    }
    const holdId = `H${this.holdSeq++}`;
    acc.held += op.amount;
    this.holds.set(holdId, { id: holdId, account: acc.id, amount: op.amount, state: 'open' });
    return { status: 'ok', holdId };
  }

  #settle(op) {
    if (typeof op.holdId !== 'string') throw new InvalidInput('settle.holdId must be a string');
    const hold = this.holds.get(op.holdId);
    if (!hold) return { status: 'rejected', reason: 'hold_not_found' };
    if (hold.state !== 'open') return { status: 'rejected', reason: 'hold_not_open' };
    const acc = this.#account(hold.account);
    if (acc.frozen) return { status: 'rejected', reason: 'account_frozen' };
    acc.held -= hold.amount;
    acc.balance -= hold.amount;
    hold.state = 'settled';
    return { status: 'ok', holdId: hold.id, amount: hold.amount };
  }

  #cancel(op) {
    if (typeof op.holdId !== 'string') throw new InvalidInput('cancel.holdId must be a string');
    const hold = this.holds.get(op.holdId);
    if (!hold) return { status: 'rejected', reason: 'hold_not_found' };
    if (hold.state !== 'open') return { status: 'rejected', reason: 'hold_not_open' };
    const acc = this.#account(hold.account);
    if (acc.frozen) return { status: 'rejected', reason: 'account_frozen' };
    acc.held -= hold.amount;
    hold.state = 'cancelled';
    return { status: 'ok', holdId: hold.id, amount: hold.amount };
  }

  snapshot() {
    return {
      accounts: this.accounts.map((a) => ({ ...a })),
      holds: [...this.holds.values()].map((h) => ({ ...h })),
    };
  }
}
