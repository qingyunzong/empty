import { InvalidInputError } from './errors.js';

export const OP_TYPES = new Set(['reserve', 'settle', 'cancel']);

export class Ledger {
  constructor(balances, frozenIndices = []) {
    this.accounts = balances.map((balance, index) => ({
      balance,
      held: 0,
      frozen: frozenIndices.includes(index),
    }));
    this.reservations = {};
  }

  snapshot() {
    return JSON.parse(JSON.stringify({
      accounts: this.accounts,
      reservations: this.reservations,
    }));
  }

  apply(op) {
    switch (op.type) {
      case 'reserve':
        return this.#reserve(op);
      case 'settle':
        return this.#settle(op);
      case 'cancel':
        return this.#cancel(op);
      default:
        throw new InvalidInputError(`unknown op type: ${op.type}`);
    }
  }

  #reserve(op) {
    const account = this.accounts[op.account];
    if (!account) {
      return { result: 'rejected', reason: 'UNKNOWN_ACCOUNT' };
    }
    if (account.frozen) {
      return { result: 'rejected', reason: 'ACCOUNT_FROZEN' };
    }
    if (!Number.isInteger(op.amount) || op.amount <= 0) {
      return { result: 'rejected', reason: 'INVALID_AMOUNT' };
    }
    if (op.amount > account.balance - account.held) {
      return { result: 'rejected', reason: 'INSUFFICIENT_FUNDS' };
    }
    if (this.reservations[op.reservationId]) {
      return { result: 'rejected', reason: 'DUPLICATE_RESERVATION' };
    }
    account.held += op.amount;
    this.reservations[op.reservationId] = {
      id: op.reservationId,
      account: op.account,
      amount: op.amount,
      status: 'open',
    };
    return { result: 'applied' };
  }

  #settle(op) {
    const reservation = this.reservations[op.reservationId];
    if (!reservation) {
      return { result: 'rejected', reason: 'UNKNOWN_RESERVATION' };
    }
    if (reservation.status !== 'open') {
      return { result: 'rejected', reason: `RACE_NOT_OPEN:${reservation.status}` };
    }
    const account = this.accounts[reservation.account];
    account.held -= reservation.amount;
    account.balance -= reservation.amount;
    reservation.status = 'settled';
    return { result: 'applied' };
  }

  #cancel(op) {
    const reservation = this.reservations[op.reservationId];
    if (!reservation) {
      return { result: 'rejected', reason: 'UNKNOWN_RESERVATION' };
    }
    if (reservation.status === 'settled') {
      return { result: 'rejected', reason: 'RACE_ALREADY_SETTLED' };
    }
    if (reservation.status === 'cancelled') {
      return { result: 'rejected', reason: 'RACE_ALREADY_CANCELLED' };
    }
    const account = this.accounts[reservation.account];
    account.held -= reservation.amount;
    reservation.status = 'cancelled';
    return { result: 'applied' };
  }
}
